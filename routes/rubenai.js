const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BACKEND_URL || 'https://ree-backend-production.up.railway.app');

function getAnthropicKey() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_key'").get();
    if (row && row.value && row.value.length > 10) return row.value;
  } catch (e) {}
  return process.env.ANTHROPIC_API_KEY || '';
}

function getProductCatalog() {
  try {
    const db = getDb();
    const products = db.prepare(`
      SELECT p.id, p.name, p.model, p.price, p.sale_price, p.stock_status, p.stock_quantity,
             b.name as brand, c.name as category,
             (SELECT filename FROM product_images WHERE product_id = p.id AND is_main = 1 LIMIT 1) as has_image
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.status IN ('approved', 'published')
      ORDER BY c.name, p.price
      LIMIT 200
    `).all();
    const attrStmt = db.prepare('SELECT name, value FROM product_attributes WHERE product_id = ?');
    return products.map(p => {
      const attrs = attrStmt.all(p.id);
      const attrStr = attrs.map(a => `${a.name}: ${a.value}`).join(', ');
      const priceStr = p.sale_price ? `$${p.price} (oferta: $${p.sale_price})` : `$${p.price || 'Consultar'}`;
      return `- [ID:${p.id}] ${p.name}${p.model ? ` (${p.model})` : ''} | Marca: ${p.brand || 'N/A'} | Cat: ${p.category || 'N/A'} | Precio: ${priceStr} COP | Stock: ${p.stock_status === 'instock' ? `Disponible (${p.stock_quantity} uds)` : 'Agotado'} | Foto: ${p.has_image ? 'Sí' : 'No'}${attrStr ? ` | Specs: ${attrStr}` : ''}`;
    }).join('\n');
  } catch (e) { return 'Catálogo no disponible'; }
}

function findRelatedProducts(text) {
  try {
    const db = getDb();
    const allProducts = db.prepare(`
      SELECT p.id, p.name, p.model, p.price, p.sale_price, p.stock_status,
             (SELECT filename FROM product_images WHERE product_id = p.id AND is_main = 1 LIMIT 1) as main_image
      FROM products p
      WHERE p.status IN ('approved', 'published')
    `).all();

    const textLower = text.toLowerCase();
    
    // Detectar IDs mencionados con [ID:X]
    const idMatches = [...text.matchAll(/\[ID:(\d+)\]/g)].map(m => parseInt(m[1]));
    
    const matched = allProducts.filter(p => {
      if (idMatches.includes(p.id)) return true;
      const nameLower = p.name.toLowerCase();
      const modelLower = (p.model || '').toLowerCase();
      const words = nameLower.split(' ').filter(w => w.length > 3);
      const matchScore = words.filter(w => textLower.includes(w)).length;
      return matchScore >= 2 || (modelLower.length > 3 && textLower.includes(modelLower));
    }).slice(0, 5);

    return matched.map(p => ({
      id: p.id,
      name: p.name,
      model: p.model,
      price: p.price,
      sale_price: p.sale_price,
      stock_status: p.stock_status,
      main_image: p.main_image || null,
      image: p.main_image ? `${BACKEND_URL}/uploads/images/${p.main_image}` : null,
    }));
  } catch (e) { return []; }
}

router.get('/status', authMiddleware, (req, res) => {
  const apiKey = getAnthropicKey();
  const db = getDb();
  const productCount = db.prepare("SELECT COUNT(*) as c FROM products WHERE status IN ('approved','published')").get();
  res.json({ ready: !!apiKey, product_count: productCount?.c || 0, version: '1.2' });
});

router.post('/chat', authMiddleware, async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Mensaje requerido' });

  const apiKey = getAnthropicKey();
  if (!apiKey) return res.status(400).json({ error: 'Configura la clave de Claude AI en Configuración → API' });

  const catalog = getProductCatalog();

  const systemPrompt = `Eres Electro-IA, el asistente técnico inteligente de REElectrosistemas, empresa colombiana especializada en productos eléctricos e industriales.

Tu personalidad: profesional, amigable, experto en electricidad y energía solar. Respondes siempre en español colombiano.

CATÁLOGO ACTUAL (precios en COP):
${catalog}

CAPACIDADES ESPECIALES:
1. PRESUPUESTO: Cuando el cliente mencione cuánto dinero tiene (ej. "tengo $500.000", "mi presupuesto es 1 millón"), INMEDIATAMENTE:
   - Lista los productos disponibles dentro de ese rango de precio
   - Prioriza los que tienen mejor relación calidad/precio
   - Menciona si hay opciones con precio de oferta
   - Sugiere la mejor opción y por qué
   - Ejemplo: "Con $500.000 tienes estas opciones: [lista productos del catálogo dentro del rango]"

2. CÁLCULO DE INVERSORES: Capacidad = Watts totales × 1.25
3. CÁLCULO DE BATERÍAS: Ah = (Watts × horas) / Voltaje / 0.8 / DOD (0.5 plomo-ácido, 0.8 litio)
4. CÁLCULO DE PANELES: Paneles = Wh diarios / 4.5h pico / 0.85 eficiencia

5. INTERÉS EN COMPRA: Si el cliente dice que quiere comprar, que está interesado, o que ya tomó una decisión, responde: "¡Excelente elección! Para continuar con tu pedido, un asesor de REElectrosistemas te contactará pronto. ¿Deseas que le dejemos tu nombre y el producto de tu interés?"

REGLAS:
- Cuando menciones un producto específico del catálogo, incluye su [ID:X] para que el sistema muestre la foto.
- Incluye precios exactos del catálogo cuando estén disponibles.
- Para cálculos, muestra los pasos.
- Máximo 400 palabras salvo cálculos detallados.
- Sé proactivo: si alguien pregunta por algo técnico, también menciona productos relevantes del catálogo.`;

  try {
    const client = new Anthropic({ apiKey });
    const messages = history.slice(-10).map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: message });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      system: systemPrompt,
      messages
    });

    const reply = response.content[0].text;
    const related_products = findRelatedProducts(message + ' ' + reply);

    res.json({ reply, related_products });
  } catch (err) {
    console.error('Electro-IA error:', err);
    res.status(500).json({ error: 'Error en Electro-IA: ' + err.message });
  }
});

module.exports = router;
