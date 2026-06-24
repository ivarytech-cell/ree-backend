const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BACKEND_URL || 'https://ree-backend-production.up.railway.app');

const DEFAULT_AI_MODEL = 'claude-haiku-4-5-20251001';

const DEFAULT_SETTINGS = {
  business_name: 'REElectrosistemas',
  ai_enabled: '1',
  ai_name: 'Asistente IA',
  ai_welcome_message: 'Hola, soy tu asistente virtual. ¿En qué puedo ayudarte?',
  ai_personality: 'Profesional, claro, amable, experto en ventas y soporte técnico.',
  ai_business_context: 'Asistente virtual para orientar clientes, responder preguntas, recomendar productos y apoyar al equipo comercial.',
  ai_model: DEFAULT_AI_MODEL,
  ai_escalation_enabled: '1',
  ai_escalation_keywords: 'comprar,cotizar,precio,asesor,humano,garantía,reclamo,problema,pedido,urgente',
  ai_auto_assign: '1',
  anthropic_key: ''
};

function getSettings() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = { ...DEFAULT_SETTINGS };

    rows.forEach((row) => {
      settings[row.key] = row.value;
    });

    return settings;
  } catch (error) {
    console.error('No se pudieron leer settings:', error.message);
    return { ...DEFAULT_SETTINGS };
  }
}

function getAnthropicKey(settings) {
  if (settings.anthropic_key && settings.anthropic_key.length > 10) {
    return settings.anthropic_key;
  }

  return process.env.ANTHROPIC_API_KEY || '';
}

function getProductCatalog() {
  try {
    const db = getDb();

    const products = db.prepare(`
      SELECT
        p.id,
        p.name,
        p.model,
        p.price,
        p.sale_price,
        p.stock_status,
        p.stock_quantity,
        b.name AS brand,
        c.name AS category,
        (
          SELECT filename
          FROM product_images
          WHERE product_id = p.id AND is_main = 1
          LIMIT 1
        ) AS has_image
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.status IN ('approved', 'published', 'draft')
      ORDER BY c.name, p.price
      LIMIT 200
    `).all();

    const attrStmt = db.prepare('SELECT name, value FROM product_attributes WHERE product_id = ?');

    if (!products || products.length === 0) {
      return 'No hay productos cargados todavía.';
    }

    return products.map((product) => {
      const attrs = attrStmt.all(product.id);
      const attrText = attrs.map((attr) => `${attr.name}: ${attr.value}`).join(', ');

      const priceText = product.sale_price
        ? `$${product.price || 'Consultar'} / oferta: $${product.sale_price}`
        : `$${product.price || 'Consultar'}`;

      return [
        `- [ID:${product.id}] ${product.name}${product.model ? ` (${product.model})` : ''}`,
        `Marca: ${product.brand || 'N/A'}`,
        `Categoría: ${product.category || 'N/A'}`,
        `Precio: ${priceText}`,
        `Stock: ${product.stock_status === 'instock' ? `Disponible (${product.stock_quantity || 0} uds)` : 'Consultar disponibilidad'}`,
        `Foto: ${product.has_image ? 'Sí' : 'No'}`,
        attrText ? `Specs: ${attrText}` : ''
      ].filter(Boolean).join(' | ');
    }).join('\n');
  } catch (error) {
    console.error('Catalog error:', error.message);
    return 'Catálogo no disponible en este momento.';
  }
}

function findRelatedProducts(text) {
  try {
    const db = getDb();

    const allProducts = db.prepare(`
      SELECT
        p.id,
        p.name,
        p.model,
        p.price,
        p.sale_price,
        p.stock_status,
        (
          SELECT filename
          FROM product_images
          WHERE product_id = p.id AND is_main = 1
          LIMIT 1
        ) AS main_image
      FROM products p
      WHERE p.status IN ('approved', 'published', 'draft')
    `).all();

    const safeText = String(text || '');
    const textLower = safeText.toLowerCase();

    const idMatches = [...safeText.matchAll(/\[ID:(\d+)\]/g)].map((match) => parseInt(match[1], 10));

    const matched = allProducts.filter((product) => {
      if (idMatches.includes(product.id)) return true;

      const nameLower = String(product.name || '').toLowerCase();
      const modelLower = String(product.model || '').toLowerCase();
      const words = nameLower.split(' ').filter((word) => word.length > 3);
      const matchScore = words.filter((word) => textLower.includes(word)).length;

      return matchScore >= 2 || (modelLower.length > 3 && textLower.includes(modelLower));
    }).slice(0, 5);

    return matched.map((product) => ({
      id: product.id,
      name: product.name,
      model: product.model,
      price: product.price,
      sale_price: product.sale_price,
      stock_status: product.stock_status,
      main_image: product.main_image || null,
      image: product.main_image ? `${BACKEND_URL}/uploads/images/${product.main_image}` : null
    }));
  } catch (error) {
    console.error('Related products error:', error.message);
    return [];
  }
}

function getAvailableAgents() {
  try {
    const db = getDb();

    return db.prepare(`
      SELECT
        id,
        name,
        last_name,
        email,
        username,
        role,
        status,
        team_id
      FROM agents
      WHERE status = 'available'
      ORDER BY updated_at DESC
      LIMIT 10
    `).all();
  } catch (error) {
    console.error('Agents error:', error.message);
    return [];
  }
}

function shouldEscalateToHuman(message, reply, settings) {
  if (settings.ai_escalation_enabled !== '1') {
    return false;
  }

  const keywords = String(settings.ai_escalation_keywords || '')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);

  const fullText = `${message || ''} ${reply || ''}`.toLowerCase();

  return keywords.some((keyword) => fullText.includes(keyword));
}

// GET /api/rubenai/status
router.get('/status', authMiddleware, (req, res) => {
  try {
    const settings = getSettings();
    const apiKey = getAnthropicKey(settings);
    const db = getDb();

    let productCount = 0;

    try {
      const productRow = db
        .prepare("SELECT COUNT(*) AS c FROM products WHERE status IN ('approved', 'published', 'draft')")
        .get();

      productCount = productRow?.c || 0;
    } catch (error) {
      productCount = 0;
    }

    res.json({
      ready: !!apiKey,
      enabled: settings.ai_enabled === '1',
      ai_name: settings.ai_name || 'Asistente IA',
      welcome_message: settings.ai_welcome_message || '',
      model: settings.ai_model || DEFAULT_AI_MODEL,
      product_count: productCount,
      version: '2.0'
    });
  } catch (error) {
    console.error('AI status error:', error);
    res.status(500).json({ error: 'Error consultando estado de IA: ' + error.message });
  }
});

// POST /api/rubenai/chat
router.post('/chat', authMiddleware, async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Mensaje requerido' });
  }

  const settings = getSettings();

  if (settings.ai_enabled !== '1') {
    return res.status(403).json({
      error: 'La IA está desactivada desde Configuración.'
    });
  }

  const apiKey = getAnthropicKey(settings);

  if (!apiKey) {
    return res.status(400).json({
      error: 'Configura la clave de Claude AI en Configuración.'
    });
  }

  const aiName = settings.ai_name || 'Asistente IA';
  const businessName = settings.business_name || 'la empresa';
  const catalog = getProductCatalog();

  const systemPrompt = `
Eres ${aiName}, el asistente inteligente de ${businessName}.

Personalidad:
${settings.ai_personality || DEFAULT_SETTINGS.ai_personality}

Contexto del negocio:
${settings.ai_business_context || DEFAULT_SETTINGS.ai_business_context}

Catálogo actual:
${catalog}

Reglas de atención:
1. Responde siempre en español.
2. Sé claro, profesional, amable y útil.
3. Si recomiendas productos del catálogo, incluye el ID así: [ID:X].
4. Si hay precio disponible, menciona el precio.
5. Si no hay información suficiente, dilo claramente y ofrece escalar con un agente humano.
6. Si el cliente quiere comprar, cotizar, reclamar, hablar con un asesor o necesita ayuda humana, indica que puedes escalar el caso a un agente disponible.
7. No inventes stock, precios ni especificaciones que no estén en el catálogo.
8. Responde máximo 400 palabras, salvo que el usuario pida una explicación larga.
`;

  try {
    const client = new Anthropic({ apiKey });

    const cleanHistory = Array.isArray(history)
      ? history
          .slice(-10)
          .filter((item) => item && item.role && item.content)
          .map((item) => ({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content: String(item.content)
          }))
      : [];

    cleanHistory.push({
      role: 'user',
      content: String(message)
    });

    const response = await client.messages.create({
      model: settings.ai_model || DEFAULT_AI_MODEL,
      max_tokens: 900,
      system: systemPrompt,
      messages: cleanHistory
    });

    const reply = response.content?.[0]?.text || 'No pude generar una respuesta en este momento.';
    const relatedProducts = findRelatedProducts(`${message} ${reply}`);
    const needsHuman = shouldEscalateToHuman(message, reply, settings);
    const availableAgents = needsHuman ? getAvailableAgents() : [];

    res.json({
      reply,
      ai_name: aiName,
      related_products: relatedProducts,
      needs_human: needsHuman,
      available_agents: availableAgents,
      escalation_available: availableAgents.length > 0,
      escalation_message: needsHuman
        ? availableAgents.length > 0
          ? 'Hay agentes disponibles para continuar la conversación.'
          : 'No hay agentes disponibles ahora mismo. Se puede dejar el caso pendiente.'
        : ''
    });
  } catch (error) {
    console.error(`${aiName} error:`, error);

    res.status(500).json({
      error: `Error en ${aiName}: ${error.message}`
    });
  }
});

module.exports = router;
