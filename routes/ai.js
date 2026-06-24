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

function saveSetting(key, value) {
  try {
    const db = getDb();
    ensureSettingsTable(db);

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value || '');
  } catch (error) {}
}

function normalizeApiKey(value, type = 'claude') {
  const text = String(value || '').trim();

  if (type === 'openai') {
    const match = text.match(/sk-[A-Za-z0-9_\-]+/);
    return match ? match[0] : text;
  }

  const match = text.match(/sk-ant-[A-Za-z0-9_\-]+/);
  return match ? match[0] : text;
}

function getAnthropicKey() {
  const key =
    getSetting('anthropic_key', '') ||
    getSetting('claude_key', '') ||
    process.env.ANTHROPIC_API_KEY ||
    '';

  return normalizeApiKey(key, 'claude');
}

function getOpenAIKey() {
  const key =
    getSetting('openai_key', '') ||
    getSetting('image_ai_api_key', '') ||
    getSetting('openai_images_key', '') ||
    process.env.OPENAI_API_KEY ||
    '';

  return normalizeApiKey(key, 'openai');
}

function hasClaude() {
  const key = getAnthropicKey();
  return !!key && key.startsWith('sk-ant-');
}

function hasOpenAI() {
  const key = getOpenAIKey();
  return !!key && key.startsWith('sk-');
}

function getClaudeClient() {
  const apiKey = getAnthropicKey();

  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    throw new Error('Claude AI no está conectado. Ve a Integraciones y conecta Claude AI con una API Key válida.');
  }

  return new Anthropic({ apiKey });
}

function extractJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error('La IA no devolvió JSON válido.');
  }

  return JSON.parse(match[0]);
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeFallbackProduct({ product_name = '', brand = '', category = '', text = '' }) {
  const cleanText = stripHtml(text).slice(0, 900);
  const guessedName = product_name || cleanText.split('\n')[0] || 'Producto sin nombre';

  return {
    name: guessedName,
    short_description: cleanText
      ? cleanText.slice(0, 180)
      : 'Producto técnico disponible para completar con información del datasheet.',
    description: cleanText
      ? `<p>${cleanText.slice(0, 1200)}</p>`
      : '<p>Producto pendiente de completar con información técnica.</p>',
    model: '',
    brand: brand || '',
    category: category || '',
    attributes: [],
    seo_keyword: guessedName,
    seo_title: guessedName.slice(0, 60),
    seo_description: cleanText
      ? cleanText.slice(0, 155)
      : 'Producto técnico para catálogo online.',
    ai_warning: 'No se pudo usar la IA, pero el sistema procesó el archivo y generó una base editable.'
  };
}

function getUploadedFile(req) {
  if (req.file) return req.file;

  if (Array.isArray(req.files) && req.files.length > 0) {
    return req.files[0];
  }

  if (req.files && typeof req.files === 'object') {
    const keys = Object.keys(req.files);
    for (const key of keys) {
      if (Array.isArray(req.files[key]) && req.files[key][0]) {
        return req.files[key][0];
      }
    }
  }

  return null;
}

async function readUploadedFile(file) {
  if (!file) {
    throw new Error('No se recibió archivo.');
  }

  const buffer = fs.readFileSync(file.path);
  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  const mimetype = String(file.mimetype || '').toLowerCase();

  if (ext === '.pdf' || mimetype.includes('pdf')) {
    const data = await pdfParse(buffer);

    return {
      text: String(data.text || '').substring(0, 12000),
      pages: data.numpages || 0,
      info: data.info || {},
      file_type: 'pdf'
    };
  }

  if (ext === '.txt' || mimetype.includes('text')) {
    return {
      text: buffer.toString('utf8').substring(0, 12000),
      pages: 0,
      info: {},
      file_type: 'text'
    };
  }

  return {
    text: '',
    pages: 0,
    info: {},
    file_type: ext.replace('.', '') || 'file',
    warning: 'El archivo fue recibido, pero este formato no permite extraer texto directamente.'
  };
}

function deleteUploadedFile(file) {
  try {
    if (file?.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  } catch (error) {}
}

function ensureGeneratedFolder() {
  const folder = path.join(__dirname, '..', 'uploads', 'generated');

  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }

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
  const map = {
    square: '1024x1024',
    post: '1024x1024',
    '1:1': '1024x1024',
    '1080x1080': '1024x1024',

    vertical: '1024x1536',
    '4:5': '1024x1536',
    story: '1024x1536',
    reel: '1024x1536',
    flyer: '1024x1536',

    horizontal: '1536x1024',
    banner: '1536x1024',
    web: '1536x1024'
  };

  const clean = String(size || '').trim().toLowerCase();

  if (['1024x1024', '1024x1536', '1536x1024', 'auto'].includes(clean)) {
    return clean;
  }

  return map[clean] || '1024x1024';
}

function normalizeQuality(quality) {
  const clean = String(quality || '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'auto'].includes(clean) ? clean : 'medium';
}

function getCommerceContext() {
  try {
    const db = getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS commerce_info (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME
      );
    `);

    const rows = db.prepare('SELECT key, value FROM commerce_info').all();
    const info = {};

    rows.forEach((row) => {
      info[row.key] = row.value;
    });

    return info;
  } catch (error) {
    return {};
  }
}

async function improvePromptWithClaude(rawPrompt, context = '') {
  if (!hasClaude()) {
    return rawPrompt;
  }

  const client = getClaudeClient();
  const commerce = getCommerceContext();

  const prompt = `
Eres un director creativo experto en marketing visual para productos eléctricos, industriales, seguridad electrónica y energía solar.

Mejora este prompt para una IA generadora de imágenes.

Negocio: ${commerce.business_name || 'REElectrosistemas'}
Estilo visual de marca: ${commerce.brand_visual_style || 'moderno, técnico y profesional'}
Colores de marca: ${commerce.brand_primary_color || ''} ${commerce.brand_secondary_color || ''} ${commerce.brand_accent_color || ''}
Tipografía sugerida: ${commerce.brand_heading_font || ''} ${commerce.brand_body_font || ''}
Tono: ${commerce.brand_tone || 'profesional, claro y comercial'}
Slogan: ${commerce.brand_slogan || ''}
Instagram: ${commerce.instagram || ''}
Teléfono/WhatsApp: ${commerce.whatsapp || commerce.phone || ''}
Contexto: ${context || 'imagen comercial de producto'}

Prompt original:
${rawPrompt}

Devuelve solo el prompt final, sin explicación. Debe especificar composición, fondo, iluminación, estilo, jerarquía visual, texto legible si aplica, y que la imagen se vea profesional, realista y comercial.
`;

  const message = await client.messages.create({
    model: getSetting('ai_model', CLAUDE_MODEL) || CLAUDE_MODEL,
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content?.[0]?.text?.trim() || rawPrompt;
}

async function generateImageWithOpenAI(prompt, options = {}) {
  const apiKey = getOpenAIKey();

  if (!apiKey || !apiKey.startsWith('sk-')) {
    throw new Error('OpenAI no está conectado. Ve a Integraciones y conecta ChatGPT / OpenAI u OpenAI Imágenes.');
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

  if (!item) {
    throw new Error('OpenAI no devolvió imagen.');
  }

  if (item.b64_json) {
    return saveBase64Image(item.b64_json, 'openai-image');
  }

  if (item.url) {
    return {
      url: item.url,
      filename: null,
      filepath: null
    };
  }

  throw new Error('OpenAI no devolvió una imagen válida.');
}

async function generateProductWithClaude({ text = '', product_name = '', category = '', brand = '' }) {
  if (!hasClaude()) {
    return makeFallbackProduct({ product_name, brand, category, text });
  }

  const client = getClaudeClient();

  const prompt = `
Eres un experto en productos eléctricos, industriales, cámaras, seguridad, energía solar, redes y automatización.

Genera información completa para este producto en español.

Producto/Modelo:
${product_name || 'No especificado'}

Marca:
${brand || 'No especificada'}

Categoría:
${category || 'No especificada'}

Información del datasheet o texto:
${String(text || '').substring(0, 6000)}

Responde ÚNICAMENTE con JSON válido:
{
  "name": "nombre completo del producto",
  "short_description": "descripción corta comercial de 1-2 oraciones",
  "description": "descripción detallada en HTML con beneficios, usos y características",
  "model": "modelo/referencia",
  "brand": "marca detectada o vacía",
  "category": "categoría detectada o vacía",
  "attributes": [
    { "name": "atributo", "value": "valor" }
  ],
  "seo_keyword": "palabra clave principal",
  "seo_title": "título SEO máximo 60 caracteres",
  "seo_description": "meta descripción máximo 155 caracteres"
}
`;

  const message = await client.messages.create({
    model: getSetting('ai_model', CLAUDE_MODEL) || CLAUDE_MODEL,
    max_tokens: 1800,
    messages: [{ role: 'user', content: prompt }]
  });

  const responseText = message.content?.[0]?.text?.trim() || '';
  return extractJson(responseText);
}

// GET /api/ai/status
router.get('/status', authMiddleware, (req, res) => {
  res.json({
    claude_connected: hasClaude(),
    openai_connected: hasOpenAI(),
    claude_model: getSetting('ai_model', CLAUDE_MODEL) || CLAUDE_MODEL,
    image_model: getSetting('image_ai_model', OPENAI_IMAGE_MODEL) || OPENAI_IMAGE_MODEL
  });
});

// POST /api/ai/parse-datasheet
router.post('/parse-datasheet', authMiddleware, uploadDatasheet.any(), async (req, res) => {
  const file = getUploadedFile(req);

  if (!file) {
    return res.status(400).json({
      error: 'No se recibió archivo.'
    });
  }

  try {
    const parsed = await readUploadedFile(file);
    deleteUploadedFile(file);

    res.json({
      success: true,
      ...parsed
    });
  } catch (error) {
    deleteUploadedFile(file);
    console.error('[ai] parse-datasheet error:', error);

    res.status(500).json({
      success: false,
      error: 'Error leyendo el archivo: ' + error.message
    });
  }
});

// POST /api/ai/process-datasheet
router.post('/process-datasheet', authMiddleware, uploadDatasheet.any(), async (req, res) => {
  const file = getUploadedFile(req);

  if (!file) {
    return res.status(400).json({
      success: false,
      error: 'No se recibió archivo.'
    });
  }

  try {
    const parsed = await readUploadedFile(file);
    deleteUploadedFile(file);

    let product;

    try {
      product = await generateProductWithClaude({
        text: parsed.text,
        product_name: req.body?.product_name || req.body?.name || '',
        category: req.body?.category || '',
        brand: req.body?.brand || ''
      });
    } catch (aiError) {
      product = makeFallbackProduct({
        product_name: req.body?.product_name || req.body?.name || '',
        category: req.body?.category || '',
        brand: req.body?.brand || '',
        text: parsed.text
      });

      product.ai_warning = aiError.message;
    }

    res.json({
      success: true,
      text: parsed.text,
      pages: parsed.pages,
      info: parsed.info,
      product,
      ...product
    });
  } catch (error) {
    deleteUploadedFile(file);
    console.error('[ai] process-datasheet error:', error);

    res.status(500).json({
      success: false,
      error: 'Error procesando el archivo: ' + error.message
    });
  }
});

// Alias para frontends viejos
router.post('/analyze-datasheet', authMiddleware, uploadDatasheet.any(), async (req, res) => {
  const file = getUploadedFile(req);

  if (!file) {
    return res.status(400).json({
      success: false,
      error: 'No se recibió archivo.'
    });
  }

  try {
    const parsed = await readUploadedFile(file);
    deleteUploadedFile(file);

    let product;

    try {
      product = await generateProductWithClaude({
        text: parsed.text,
        product_name: req.body?.product_name || req.body?.name || '',
        category: req.body?.category || '',
        brand: req.body?.brand || ''
      });
    } catch (aiError) {
      product = makeFallbackProduct({
        product_name: req.body?.product_name || req.body?.name || '',
        category: req.body?.category || '',
        brand: req.body?.brand || '',
        text: parsed.text
      });

      product.ai_warning = aiError.message;
    }

    res.json({
      success: true,
      text: parsed.text,
      pages: parsed.pages,
      info: parsed.info,
      product,
      ...product
    });
  } catch (error) {
    deleteUploadedFile(file);
    console.error('[ai] analyze-datasheet error:', error);

    res.status(500).json({
      success: false,
      error: 'Error procesando el archivo: ' + error.message
    });
  }
});

// POST /api/ai/generate-product
router.post('/generate-product', authMiddleware, async (req, res) => {
  const { text, product_name, name, category, brand } = req.body || {};

  if (!text && !product_name && !name) {
    return res.status(400).json({
      error: 'Se requiere texto o nombre del producto.'
    });
  }

  try {
    const product = await generateProductWithClaude({
      text: text || '',
      product_name: product_name || name || '',
      category: category || '',
      brand: brand || ''
    });

    res.json(product);
  } catch (error) {
    console.error('[ai] generate-product error:', error);

    res.json(makeFallbackProduct({
      product_name: product_name || name || '',
      category: category || '',
      brand: brand || '',
      text: text || ''
    }));
  }
});

// POST /api/ai/generate-specs
router.post('/generate-specs', authMiddleware, async (req, res) => {
  const { product_name, category, brand, model, text } = req.body || {};

  if (!product_name && !text) {
    return res.status(400).json({
      error: 'Se requiere nombre o texto del producto.'
    });
  }

  if (!hasClaude()) {
    return res.json({
      specs: [],
      datasheet_summary: 'Claude AI no está conectado. Completa la integración para generar especificaciones automáticamente.',
      ai_warning: 'Claude AI no conectado.'
    });
  }

  try {
    const client = getClaudeClient();

    const prompt = `
Eres un experto técnico en productos eléctricos e industriales.

Genera especificaciones técnicas para:
Producto: ${product_name || ''}
Modelo: ${model || ''}
Marca: ${brand || ''}
Categoría: ${category || ''}
Información adicional:
${String(text || '').substring(0, 3500)}

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
      model: getSetting('ai_model', CLAUDE_MODEL) || CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json(extractJson(message.content?.[0]?.text || ''));
  } catch (error) {
    console.error('[ai] generate-specs error:', error);

    res.status(500).json({
      error: 'Error generando especificaciones: ' + error.message
    });
  }
});

// POST /api/ai/seo
router.post('/seo', authMiddleware, async (req, res) => {
  const { name, description, category, brand } = req.body || {};

  if (!name) {
    return res.status(400).json({
      error: 'Nombre requerido.'
    });
  }

  if (!hasClaude()) {
    return res.json({
      seo_keyword: name,
      seo_title: String(name).slice(0, 60),
      seo_description: stripHtml(description || name).slice(0, 155),
      ai_warning: 'Claude AI no conectado.'
    });
  }

  try {
    const client = getClaudeClient();

    const prompt = `
Genera SEO optimizado en español para este producto:
Nombre: ${name}
Marca: ${brand || ''}
Categoría: ${category || ''}
Descripción: ${String(description || '').substring(0, 900)}

Responde SOLO con JSON:
{
  "seo_keyword": "...",
  "seo_title": "...",
  "seo_description": "..."
}
`;

    const message = await client.messages.create({
      model: getSetting('ai_model', CLAUDE_MODEL) || CLAUDE_MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json(extractJson(message.content?.[0]?.text || ''));
  } catch (error) {
    res.status(500).json({
      error: 'Error generando SEO: ' + error.message
    });
  }
});

// POST /api/ai/improve-prompt
router.post('/improve-prompt', authMiddleware, async (req, res) => {
  const { prompt, context } = req.body || {};

  if (!prompt) {
    return res.status(400).json({
      error: 'Prompt requerido.'
    });
  }

  try {
    const improvedPrompt = await improvePromptWithClaude(prompt, context || 'product_image');

    res.json({
      success: true,
      prompt: improvedPrompt,
      improved_prompt: improvedPrompt
    });
  } catch (error) {
    res.json({
      success: true,
      prompt,
      improved_prompt: prompt,
      warning: error.message
    });
  }
});

// POST /api/ai/generate-image
router.post('/generate-image', authMiddleware, async (req, res) => {
  try {
    const {
      prompt,
      provider = 'openai',
      size,
      quality,
      model
    } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'Prompt requerido.'
      });
    }

    let finalPrompt = prompt;

    if (provider === 'claude' || provider === 'claude_ai' || provider === 'claude_design') {
      finalPrompt = await improvePromptWithClaude(prompt, 'product_image_generation');
    }

    const image = await generateImageWithOpenAI(finalPrompt, {
      size,
      quality,
      model
    });

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

// POST /api/ai/search-youtube
router.post('/search-youtube', authMiddleware, async (req, res) => {
  const { query, product_name, model, brand } = req.body || {};
  const searchText = query || [brand, product_name, model, 'review instalación'].filter(Boolean).join(' ');

  if (!searchText) {
    return res.status(400).json({
      error: 'Query requerido.'
    });
  }

  res.json({
    search_url: `https://www.youtube.com/results?search_query=${encodeURIComponent(searchText)}`,
    query: searchText
  });
});

module.exports = router;
