
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BACKEND_URL || 'https://ree-backend-production.up.railway.app');

function safeJson(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function tableExists(db, name) { try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; } }
function getColumns(db, table) { try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; } }
function getSetting(db, key, fallback = '') { try { const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return row?.value || fallback || ''; } catch { return fallback || ''; } }
function productImageUrl(filename) { if (!filename) return null; const value = String(filename); if (value.startsWith('http://') || value.startsWith('https://')) return value; return `${BACKEND_URL}/uploads/images/${value}`; }

function getClaudeKey() {
  try {
    const db = getDb();
    const direct = getSetting(db, 'anthropic_key', '') || getSetting(db, 'claude_key', '');
    if (String(direct).startsWith('sk-ant-')) return String(direct);
    const aiSettings = safeJson(getSetting(db, 'ai_assistant_settings', '{}'), {});
    const maybe = aiSettings?.integrations?.anthropic_key || aiSettings?.claude_key || '';
    if (String(maybe).startsWith('sk-ant-')) return String(maybe);
  } catch (e) {}
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
}
function getModel() { try { const db = getDb(); return getSetting(db, 'claude_model', '') || getSetting(db, 'ai_model', '') || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001'; } catch { return process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001'; } }
function cleanReply(text) { return String(text || '').replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(); }
function roleFromReq(req) { return String(req.user?.role || req.auth?.role || '').toLowerCase(); }
function isTechReq(req) { return ['tecnico','técnico','technician'].includes(roleFromReq(req)); }

function getProductCatalog(context = 'internal') {
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
    const where = [];
    if (cols.includes('status')) where.push("COALESCE(p.status,'') NOT IN ('deleted','archived')");
    if (context === 'technician' && cols.includes('is_visible_to_technicians')) where.push('COALESCE(p.is_visible_to_technicians,0)=1');
    const statusFilter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const techPrice = cols.includes('technician_price') ? 'p.technician_price' : '0';
    const sql = `
      SELECT p.id,
             ${cols.includes('name') ? 'p.name' : "'Producto sin nombre'"} AS name,
             ${cols.includes('sku') ? 'p.sku' : 'NULL'} AS sku,
             ${cols.includes('model') ? 'p.model' : 'NULL'} AS model,
             ${cols.includes('price') ? 'p.price' : '0'} AS price,
             ${cols.includes('sale_price') ? 'p.sale_price' : '0'} AS sale_price,
             ${cols.includes('regular_price') ? 'p.regular_price' : '0'} AS regular_price,
             ${techPrice} AS technician_price,
             ${cols.includes('stock_status') ? 'p.stock_status' : "'instock'"} AS stock_status,
             ${cols.includes('stock_quantity') ? 'p.stock_quantity' : '0'} AS stock_quantity,
             ${cols.includes('commercial_status') ? 'p.commercial_status' : "'available'"} AS commercial_status,
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
      LIMIT 700
    `;
    return db.prepare(sql).all().map((p) => {
      const normal = Number(p.sale_price || p.price || p.regular_price || 0);
      const tech = Number(p.technician_price || normal || 0);
      const price = context === 'technician' ? tech : normal;
      return {
        id: p.id,
        name: p.name || 'Producto sin nombre',
        sku: p.sku || '',
        model: p.model || '',
        price,
        regular_price: Number(p.price || p.regular_price || 0),
        sale_price: Number(p.sale_price || 0),
        technician_price: tech,
        stock_status: p.stock_status || 'instock',
        stock_quantity: Number(p.stock_quantity || 0),
        commercial_status: p.commercial_status || 'available',
        brand: p.brand || '',
        category: p.category || '',
        main_image: p.main_image || null,
        image: productImageUrl(p.main_image),
        description: p.short_description || p.description || ''
      };
    });
  } catch (e) {
    console.error('[ai] product catalog error:', e.message);
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
  const scored = catalog.map((p) => ({ ...p, score: scoreProduct(p, text) })).filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  const unique = [];
  const seen = new Set();
  [...matchedById, ...scored].forEach((p) => { if (!seen.has(p.id)) { seen.add(p.id); unique.push(p); } });
  return unique.slice(0, 6).map((p) => ({
    id: p.id, name: p.name, model: p.model, sku: p.sku, price: p.price,
    sale_price: p.sale_price, technician_price: p.technician_price,
    stock_status: p.stock_status, stock_quantity: p.stock_quantity,
    main_image: p.main_image || null, image: p.image || null
  }));
}
function catalogText(catalog, context) {
  return catalog.slice(0, 220).map((p) => {
    const priceLabel = context === 'technician' ? 'Precio técnico' : 'Precio venta';
    const price = p.price ? `RD$ ${Number(p.price).toLocaleString('es-DO')}` : 'Consultar precio';
    return `[ID:${p.id}] ${p.name}${p.sku ? ` | SKU: ${p.sku}` : ''}${p.model ? ` | Modelo: ${p.model}` : ''}${p.brand ? ` | Marca: ${p.brand}` : ''}${p.category ? ` | Categoría: ${p.category}` : ''} | ${priceLabel}: ${price} | Stock: ${p.stock_status === 'instock' ? `Disponible (${p.stock_quantity})` : 'Agotado'}`;
  }).join('\n');
}
function localReply(message, catalog, context) {
  const related = findRelatedProducts(message, catalog);
  if (!related.length) return context === 'technician'
    ? 'Puedo ayudarte con productos autorizados para técnicos. Dime si buscas cámaras, inversores, alarmas, paneles solares o algún modelo específico.'
    : 'Puedo ayudarte a elegir el producto correcto. Dime si buscas cámaras, inversores, paneles solares, alarmas, control de acceso o algún modelo específico.';
  const lines = related.map((p, i) => `${i + 1}. ${p.name}${p.sku ? ` (${p.sku})` : ''}\nPrecio: ${p.price ? `RD$ ${Number(p.price).toLocaleString('es-DO')}` : 'Consultar'}\nStock: ${p.stock_status === 'instock' ? `Disponible (${p.stock_quantity || 0})` : 'Agotado'}`).join('\n\n');
  return `Encontré estas opciones:\n\n${lines}\n\nSi te interesa una, dime cuál y te ayudo con el siguiente paso.`;
}

async function answerWithAi({ message, history = [], context = 'internal' }) {
  const catalog = getProductCatalog(context);
  const apiKey = getClaudeKey();
  if (!apiKey) {
    const reply = localReply(message, catalog, context);
    return { reply, answer: reply, products: findRelatedProducts(message + ' ' + reply, catalog), related_products: findRelatedProducts(message + ' ' + reply, catalog), provider: 'local', product_count: catalog.length };
  }
  const systemPrompt = `Eres Rubén IA, asistente comercial y técnico de REElectrosistemas en República Dominicana.

Habla natural, claro y vendedor.

No uses negritas con asteriscos.

No uses markdown pesado.

Responde con espacios entre ideas para que parezca una conversación natural.

Nunca reveles costo interno, margen, proveedor ni información privada.

${context === 'technician' ? 'El usuario es técnico. Usa solo precios técnicos y productos autorizados para técnicos. Ayuda a crear pedidos técnicos.' : 'Usa precios normales de venta en RD$.'}

Cuando menciones productos del catálogo, incluye su [ID:X] para que la app pueda mostrar la foto.

Si el usuario muestra interés en comprar, dile que puedes conectarlo con un asesor.

Catálogo disponible:
${catalogText(catalog, context)}`;
  try {
    const client = new Anthropic({ apiKey });
    const messages = Array.isArray(history)
      ? history.slice(-10).filter((m) => m && m.content).map((m) => ({ role: m.role === 'assistant' || m.role === 'ai' ? 'assistant' : 'user', content: String(m.content) }))
      : [];
    messages.push({ role: 'user', content: String(message) });
    const response = await client.messages.create({ model: getModel(), max_tokens: 900, system: systemPrompt, messages });
    const reply = cleanReply(response.content?.[0]?.text || 'Puedo ayudarte con ese producto.');
    const products = findRelatedProducts(message + ' ' + reply, catalog);
    return { reply, answer: reply, products, related_products: products, provider: 'claude', product_count: catalog.length };
  } catch (err) {
    console.error('[ai] Claude error:', err.response?.data || err.message);
    const reply = localReply(message, catalog, context);
    const products = findRelatedProducts(message + ' ' + reply, catalog);
    return { reply, answer: reply, products, related_products: products, provider: 'local_fallback', product_count: catalog.length, warning: 'Claude falló, se usó respuesta local.' };
  }
}

router.get('/status', authMiddleware, (req, res) => {
  const context = isTechReq(req) ? 'technician' : 'internal';
  const catalog = getProductCatalog(context);
  res.json({ ready: !!getClaudeKey(), product_count: catalog.length, version: '2.0-v69-unified-ai', model: getModel(), provider: getClaudeKey() ? 'claude' : 'local', context });
});
router.post('/chat', authMiddleware, async (req, res, next) => {
  try { const { message, history = [], context } = req.body || {}; if (!message) return res.status(400).json({ error: 'Mensaje requerido' }); const ctx = context || (isTechReq(req) ? 'technician' : 'internal'); res.json(await answerWithAi({ message, history, context: ctx })); } catch (e) { next(e); }
});
router.post('/internal/message', authMiddleware, async (req, res, next) => {
  try { const { message, history = [] } = req.body || {}; if (!message) return res.status(400).json({ error: 'Mensaje requerido' }); res.json(await answerWithAi({ message, history, context: 'internal' })); } catch (e) { next(e); }
});
router.post('/technician/message', authMiddleware, async (req, res, next) => {
  try { const { message, history = [] } = req.body || {}; if (!message) return res.status(400).json({ error: 'Mensaje requerido' }); res.json(await answerWithAi({ message, history, context: 'technician' })); } catch (e) { next(e); }
});

// Rutas de configuración, widget, conocimiento y leads. Siguen funcionando, pero ahora cuelgan del módulo unificado.
router.use('/', require('./ai-assistant-control'));

module.exports = router;
