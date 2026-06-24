const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { uploadDatasheet } = require('../middleware/upload');

const router = express.Router();

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BACKEND_URL || 'https://ree-backend-production.up.railway.app');

function ensureSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function getSetting(key, fallback = '') {
  try {
    const db = getDb();
    ensureSettingsTable(db);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value || fallback || '';
  } catch (error) {
    return fallback || '';
  }
}

function getAnthropicKey() {
  return getSetting('anthropic_key', process.env.ANTHROPIC_API_KEY || '');
}

function getOpenAIKey() {
  return getSetting('openai_key', process.env.OPENAI_API_KEY || '') || getSetting('image_ai_api_key', '');
}

function getClaudeClient() {
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    throw new Error('No hay clave de Claude configurada. Ve a Integraciones y conecta Claude AI.');
  }
  return new Anthropic({ apiKey });
}

function extractJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('La IA no devolvió un JSON válido.');
  return JSON.parse(match[0]);
}

function ensureGeneratedFolder() {
  const folder = path.join(__dirname, '..', 'uploads', 'generated');
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function saveBase64Image(base64, prefix = 'ai-image') {
  const folder = ensureGeneratedFolder();
  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
  const filepath = path.join(folder, filename);
  fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
  return {
    filename,
    filepath,
    url: `${BACKEND_URL}/uploads/generated/${filename}`
  };
}

function normalizeImageSize(size) {
  const allowed = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
  return allowed.has(size) ? size : '1024x1024';
}

function normalizeQuality(quality) {
  const allowed = new Set(['low', 'medium', 'high', 'auto']);
  return allowed.has(quality) ? quality : 'medium';
}

function getCommerceContext() {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS commerce_info (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);`);
    const rows = db.prepare('SELECT key, value FROM commerce_info').all();
    const info = {};
    rows.forEach((row) => { info[row.key] = row.value; });
    return info;
  } catch (error) {
    return {};
  }
}

async function improvePromptWithClaude(rawPrompt, context = '') {
  const client = getClaudeClient();
  const commerce = getCommerceContext();

  const prompt = `
Eres un director creativo experto en marketing visual para productos eléctricos, industriales y tecnológicos.

Mejora este prompt para generar una imagen comercial profesional.

Contexto adicional: ${context || 'imagen de producto'}
Negocio: ${commerce.business_name || 'REElectrosistemas'}
Estilo de marca: ${commerce.brand_visual_style || 'moderno, técnico y profesional'}
Colores de marca: ${commerce.brand_primary_color || ''} ${commerce.brand_secondary_color || ''} ${commerce.brand_accent_color || ''}
Tono: ${commerce.brand_tone || 'profesional, claro y comercial'}
Slogan: ${commerce.brand_slogan || ''}
Instagram: ${commerce.instagram || ''}
Teléfono/WhatsApp: ${commerce.whatsapp || commerce.phone || ''}

Prompt original:
${rawPrompt}

Devuelve solo el prompt final, en español, sin explicaciones. Debe ser claro para una IA generadora de imágenes, indicar composición, iluminación, estilo visual, fondo y jerarquía comercial. Si hay precio, pide que se vea legible en RD$.
`;

  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content?.[0]?.text?.trim() || rawPrompt;
}

async function generateImageWithOpenAI(prompt, options = {}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new Error('No hay API Key de OpenAI configurada. Ve a Integraciones y conecta ChatGPT / OpenAI u OpenAI Imágenes.');
  }

  const body = {
    model: options.model || getSetting('image_ai_model', OPENAI_IMAGE_MODEL) || OPENAI_IMAGE_MODEL,
    prompt,
    n: 1,
    size: normalizeImageSize(options.size || getSetting('image_ai_size', '1024x1024')),
    quality: normalizeQuality(options.quality || getSetting('image_ai_quality', 'medium'))
  };

  const response = await axios.post('https://api.openai.com/v1/images/generations', body, {
    timeout: 120000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  const item = response.data?.data?.[0];
  if (!item) throw new Error('OpenAI no devolvió imagen.');

  if (item.b64_json) return saveBase64Image(item.b64_json, 'openai-image');
  if (item.url) return { url: item.url, filename: null, filepath: null };

  throw new Error('OpenAI no devolvió una imagen válida.');
}

// POST /api/ai/improve-prompt
router.post('/improve-prompt', authMiddleware, async (req, res) => {
  try {
    const { prompt, context } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Prompt requerido.' });

    let improvedPrompt = prompt;
    try {
      improvedPrompt = await improvePromptWithClaude(prompt, context || 'product_image');
    } catch (error) {
      improvedPrompt = prompt;
    }

    res.json({ improved_prompt: improvedPrompt, prompt: improvedPrompt });
  } catch (error) {
    res.status(500).json({ error: 'Error mejorando prompt: ' + error.message });
  }
});

// POST /api/ai/generate-image
router.post('/generate-image', authMiddleware, async (req, res) => {
  try {
    const { prompt, provider = 'openai', size, quality, model } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Prompt requerido.' });

    let finalPrompt = prompt;

    if (provider === 'claude' || provider === 'claude_ai' || provider === 'claude_design') {
      finalPrompt = await improvePromptWithClaude(prompt, 'product_image_generation');
    }

    const image = await generateImageWithOpenAI(finalPrompt, { size, quality, model });

    res.json({
      success: true,
      url: image.url,
      image_url: image.url,
      filename: image.filename,
      prompt_used: finalPrompt
    });
  } catch (error) {
    console.error('[ai] generate-image error:', error.response?.data || error.message);
    res.status(400).json({
      success: false,
      error: error.response?.data?.error?.message || error.message
    });
  }
});

// POST /api/ai/generate-product
router.post('/generate-product', authMiddleware, async (req, res) => {
  const { text, product_name, category, brand } = req.body || {};

  if (!text && !product_name) {
    return res.status(400).json({ error: 'Se requiere texto o nombre del producto.' });
  }

  try {
    const client = getClaudeClient();

    const prompt = `
Eres un experto en productos eléctricos, industriales, seguridad, cámaras, energía solar y automatización.

Genera información completa para este producto en español:
${product_name ? `Nombre/Modelo: ${product_name}` : ''}
${category ? `Categoría: ${category}` : ''}
${brand ? `Marca: ${brand}` : ''}
${text ? `Información del datasheet:\n${String(text).substring(0, 3500)}` : ''}

Responde ÚNICAMENTE con JSON válido:
{
  "name": "nombre completo del producto",
  "short_description": "descripción corta comercial de 1-2 oraciones",
  "description": "descripción detallada en HTML con beneficios, usos y características",
  "model": "modelo/referencia",
  "attributes": [
    { "name": "atributo", "value": "valor" }
  ],
  "seo_keyword": "palabra clave principal",
  "seo_title": "título SEO máximo 60 caracteres",
  "seo_description": "meta descripción máximo 155 caracteres"
}
`;

    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }]
    });

    const textResponse = message.content?.[0]?.text?.trim() || '';
    res.json(extractJson(textResponse));
  } catch (error) {
    console.error('[ai] generate-product error:', error);
    res.status(500).json({ error: 'Error generando información: ' + error.message });
  }
});

// POST /api/ai/generate-specs
router.post('/generate-specs', authMiddleware, async (req, res) => {
  const { product_name, category, brand, model, text } = req.body || {};

  if (!product_name && !text) {
    return res.status(400).json({ error: 'Se requiere nombre o texto del producto.' });
  }

  try {
    const client = getClaudeClient();

    const prompt = `
Eres un experto técnico en productos eléctricos e industriales.
Genera especificaciones técnicas para:
${product_name ? `Producto: ${product_name}` : ''}
${model ? `Modelo: ${model}` : ''}
${brand ? `Marca: ${brand}` : ''}
${category ? `Categoría: ${category}` : ''}
${text ? `Información adicional:\n${String(text).substring(0, 2500)}` : ''}

Responde ÚNICAMENTE con JSON válido:
{
  "specs": [
    { "name": "Voltaje de entrada", "value": "110/220V AC" }
  ],
  "datasheet_summary": "Resumen técnico en 2-3 oraciones"
}
Incluye 8 a 12 especificaciones técnicas con unidades cuando aplique.
`;

    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    const textResponse = message.content?.[0]?.text || '';
    res.json(extractJson(textResponse));
  } catch (error) {
    console.error('[ai] generate-specs error:', error);
    res.status(500).json({ error: 'Error generando especificaciones: ' + error.message });
  }
});

// POST /api/ai/parse-datasheet
router.post('/parse-datasheet', authMiddleware, uploadDatasheet.single('datasheet'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo.' });

  try {
    const buffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(buffer);
    try { fs.unlinkSync(req.file.path); } catch (error) {}

    res.json({
      text: String(data.text || '').substring(0, 8000),
      pages: data.numpages,
      info: data.info
    });
  } catch (error) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    console.error('[ai] parse-datasheet error:', error);
    res.status(500).json({ error: 'Error leyendo el PDF: ' + error.message });
  }
});

// POST /api/ai/seo
router.post('/seo', authMiddleware, async (req, res) => {
  const { name, description, category, brand } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nombre requerido.' });

  try {
    const client = getClaudeClient();
    const prompt = `
Genera SEO optimizado en español para este producto:
Nombre: ${name}
${brand ? `Marca: ${brand}` : ''}
${category ? `Categoría: ${category}` : ''}
${description ? `Descripción: ${String(description).substring(0, 700)}` : ''}

Responde SOLO con JSON:
{
  "seo_keyword": "...",
  "seo_title": "...",
  "seo_description": "..."
}
`;

    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json(extractJson(message.content?.[0]?.text || ''));
  } catch (error) {
    res.status(500).json({ error: 'Error generando SEO: ' + error.message });
  }
});

// POST /api/ai/search-youtube
router.post('/search-youtube', authMiddleware, async (req, res) => {
  const { query, product_name, model, brand } = req.body || {};
  const searchText = query || [brand, product_name, model, 'review', 'instalación'].filter(Boolean).join(' ');

  if (!searchText) return res.status(400).json({ error: 'Query requerido.' });

  res.json({
    search_url: `https://www.youtube.com/results?search_query=${encodeURIComponent(searchText)}`,
    query: searchText
  });
});

module.exports = router;
