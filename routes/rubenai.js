
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BACKEND_URL || 'https://ree-backend-production.up.railway.app');

function safeJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function getSetting(db, key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value || fallback || '';
  } catch { return fallback || ''; }
}

function getAnthropicKey() {
  try {
    const db = getDb();
    const settingsKey = getSetting(db, 'anthropic_key', '');
    if (settingsKey && settingsKey.startsWith('sk-ant-')) return settingsKey;
    const aiSettings = safeJson(getSetting(db, 'ai_assistant_settings', '{}'), {});
    const maybe = aiSettings?.integrations?.anthropic_key || aiSettings?.claude_key || '';
    if (maybe && String(maybe).startsWith('sk-ant-')) return String(maybe);
  } catch (e) {}
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
}

function getModel() {
  try {
    const db = getDb();
    return getSetting(db, 'claude_model', '') || getSetting(db, 'ai_model', '') || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  } catch {
    return process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  }
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
}

function getColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; }
}

function col(cols, preferred, fallback = 'NULL') {
  return cols.includes(preferred) ? preferred : fallback;
}

function productImageUrl(filename) {
  if (!filename) return null;
  const value = String(filename);
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  return `${BACKEND_URL}/uploads/images/${value}`;
}

function getProductCatalog() {
  try {
    const db = getDb();
    if (!tableExists(db, 'products')) return [];
    const cols = getColumns(db, 'products');
    const hasImages = tableExists(db, 'product_images');
    const brandJoin = tableExists(db, 'brands') && cols.includes('brand_id') ? 'LEFT JOIN brands b ON p.brand_id = b.id' : '';
    const catJoin = tableExists(db, 'categories') && cols.includes('category_id') ? 'LEFT JOIN categories c ON p.category_id = c.id' : '';
    const brandExpr = brandJoin ? 'b.name' : (cols.includes('brand_name') ? 'p.brand_name' : 'NULL');
    const catExpr = catJoin ? 'c.name' : (cols.includes('category_name') ? 'p.category_name' : 'NULL');
    const imageExpr = hasImages ? '(SELECT filename FROM product_images WHERE product_id = p.id AND is_main = 1 LIMIT 1)' : (cols.includes('main_image') ? 'p.main_image' : (cols.includes('image') ? 'p.image' : 'NULL'));
    const statusFilter = cols.includes('status') ? "WHERE COALESCE(p.status,'') NOT IN ('deleted','archived')" : '';
    const products = db.prepare(`
      SELECT p.id,
             ${cols.includes('name') ? 'p.name' : "'Producto sin nombre'"} AS name,
             ${cols.includes('sku') ? 'p.sku' : 'NULL'} AS sku,
             ${cols.includes('model') ? 'p.model' : 'NULL'} AS model,
             ${cols.includes('price') ? 'p.price' : '0'} AS price,
             ${cols.includes('sale_price') ? 'p.sale_price' : '0'} AS sale_price,
             ${cols.includes('regular_price') ? 'p.regular_price' : '0'} AS regular_price,
             ${cols.includes('stock_status') ? 'p.stock_status' : "'instock'"} AS stock_status,
             ${cols.includes('stock_quantity') ? 'p.stock_quantity' : '0'} AS stock_quantity,
             ${brandExpr} AS brand,
             ${catExpr} AS category,
             ${imageExpr} AS main_image,
             ${cols.includes('short_description') ? 'p.short_description' : 'NULL'} AS short_description,
             ${cols.includes('description') ? 'p.description' : 'NULL'} AS description
      FROM products p
      ${brandJoin}
      ${catJoin}
      ${statusFilter}
      ORDER BY COALESCE(p.stock_quantity,0) DESC, p.id DESC
      LIMIT 500
    `).all();

    return products.map((p) => ({
      id: p.id,
      name: p.name || 'Producto sin nombre',
      sku: p.sku || '',
      model: p.model || '',
      price: Number(p.sale_price || p.price || p.regular_price || 0),
      regular_price: Number(p.price || p.regular_price || 0),
      sale_price: Number(p.sale_price || 0),
      stock_status: p.stock_status || 'instock',
      stock_quantity: Number(p.stock_quantity || 0),
      brand: p.brand || '',
      category: p.category || '',
      main_image: p.main_image || null,
      image: productImageUrl(p.main_image),
      description: p.short_description || p.description || ''
    }));
  } catch (e) {
    console.error('[rubenai] catalog error:', e.message);
    return [];
  }
}

function scoreProduct(product, text) {
  const haystack = `${product.name} ${product.sku} ${product.model} ${product.brand} ${product.category} ${product.description}`.toLowerCase();
  const words = String(text || '').toLowerCase().split(/[^a-záéíóúñ0-9]+/i).filter((w) => w.length >= 3);
  let score = 0;
  words.forEach((w) => { if (haystack.includes(w)) score += 1; });
  if (product.stock_status === 'instock') score += 0.5;
  return score;
}

function findRelatedProducts(text, catalog = []) {
  const idMatches = [...String(text || '').matchAll(/\[ID:(\d+)\]/g)].map((m) => Number(m[1]));
  const matchedById = catalog.filter((p) => idMatches.includes(Number(p.id)));
  const scored = catalog
    .map((p) => ({ ...p, score: scoreProduct(p, text) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const combined = [...matchedById, ...scored];
  const unique = [];
  const seen = new Set();
  combined.forEach((p) => { if (!seen.has(p.id)) { seen.add(p.id); unique.push(p); } });
  return unique.slice(0, 5).map((p) => ({
    id: p.id,
    name: p.name,
    model: p.model,
    sku: p.sku,
    price: p.price,
    sale_price: p.sale_price,
    stock_status: p.stock_status,
    stock_quantity: p.stock_quantity,
    main_image: p.main_image || null,
    image: p.image || null
  }));
}

function catalogText(catalog) {
  return catalog.slice(0, 180).map((p) => {
    const price = p.price ? `RD$ ${Number(p.price).toLocaleString('es-DO')}` : 'Consultar precio';
    return `[ID:${p.id}] ${p.name}${p.sku ? ` | SKU: ${p.sku}` : ''}${p.model ? ` | Modelo: ${p.model}` : ''}${p.brand ? ` | Marca: ${p.brand}` : ''}${p.category ? ` | Categoría: ${p.category}` : ''} | Precio venta: ${price} | Stock: ${p.stock_status === 'instock' ? `Disponible (${p.stock_quantity})` : 'Agotado'}`;
  }).join('\n');
}

function cleanReply(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function localReply(message, catalog) {
  const related = findRelatedProducts(message, catalog);
  if (!related.length) {
    return 'Puedo ayudarte a elegir el producto correcto. Dime si buscas cámaras, inversores, paneles solares, alarmas, control de acceso o algún modelo específico.';
  }
  const lines = related.map((p, i) => `${i + 1}. ${p.name}${p.sku ? ` (${p.sku})` : ''}\nPrecio: ${p.price ? `RD$ ${Number(p.price).toLocaleString('es-DO')}` : 'Consultar'}\nStock: ${p.stock_status === 'instock' ? `Disponible (${p.stock_quantity || 0})` : 'Agotado'}`).join('\n\n');
  return `Encontré estas opciones que pueden ayudarte:\n\n${lines}\n\nSi te interesa una, dime cuál y puedo ayudarte a conectarlo con un vendedor.`;
}

router.get('/status', authMiddleware, (req, res) => {
  const apiKey = getAnthropicKey();
  const catalog = getProductCatalog();
  res.json({ ready: !!apiKey, product_count: catalog.length, version: '1.8-v68', model: getModel(), provider: 'claude' });
});

router.post('/chat', authMiddleware, async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Mensaje requerido' });

  const catalog = getProductCatalog();
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    const reply = localReply(message, catalog);
    return res.json({ reply, related_products: findRelatedProducts(message + ' ' + reply, catalog), provider: 'local' });
  }

  const systemPrompt = `Eres el asistente comercial y técnico de REElectrosistemas en República Dominicana.

Habla natural, claro y vendedor.

No uses negritas con asteriscos.

No uses markdown pesado.

Responde con espacios entre ideas para que parezca una conversación natural.

Nunca reveles costo interno, margen, proveedor ni información privada.

Usa precios de venta normales en RD$.

Cuando menciones productos del catálogo, incluye su [ID:X] para que la app pueda mostrar la foto.

Si el usuario muestra interés en comprar, dile que puedes conectarlo con un asesor.

Catálogo disponible:
${catalogText(catalog)}`;

  try {
    const client = new Anthropic({ apiKey });
    const messages = Array.isArray(history)
      ? history.slice(-10).filter((m) => m && m.content).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }))
      : [];
    messages.push({ role: 'user', content: String(message) });

    const response = await client.messages.create({
      model: getModel(),
      max_tokens: 900,
      system: systemPrompt,
      messages
    });

    const reply = cleanReply(response.content?.[0]?.text || 'Puedo ayudarte con ese producto.');
    const related_products = findRelatedProducts(message + ' ' + reply, catalog);
    return res.json({ reply, related_products, provider: 'claude' });
  } catch (err) {
    console.error('[rubenai] Claude error:', err.message);
    const reply = localReply(message, catalog);
    return res.json({ reply, related_products: findRelatedProducts(message + ' ' + reply, catalog), provider: 'local_fallback', warning: err.message });
  }
});

module.exports = router;
