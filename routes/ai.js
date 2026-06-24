const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { uploadDatasheet } = require('../middleware/upload');

const router = express.Router();

// Lee la clave desde la DB primero, luego desde el entorno
function getAnthropicKey() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_key'").get();
    if (row && row.value && row.value.length > 10) return row.value;
  } catch (e) {}
  return process.env.ANTHROPIC_API_KEY || '';
}

function getClient() {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error('No hay clave de Claude AI configurada. Ve a Configuración → API y guarda tu clave.');
  return new Anthropic({ apiKey });
}

// POST /api/ai/generate-product
router.post('/generate-product', authMiddleware, async (req, res) => {
  const { text, product_name, category, brand } = req.body;
  if (!text && !product_name) return res.status(400).json({ error: 'Se requiere texto o nombre del producto' });

  try {
    const client = getClient();
    const prompt = `Eres un experto en productos eléctricos e industriales para la empresa REElectrosistemas en Colombia.

Genera información completa para este producto en español:
${product_name ? `Nombre/Modelo: ${product_name}` : ''}
${category ? `Categoría: ${category}` : ''}
${brand ? `Marca: ${brand}` : ''}
${text ? `Información del datasheet:\n${text.substring(0, 3000)}` : ''}

Responde ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "name": "nombre completo del producto",
  "short_description": "descripción corta de 1-2 oraciones para la tienda",
  "description": "descripción detallada en HTML con párrafos <p> y características técnicas",
  "model": "modelo/referencia",
  "attributes": [{"name": "atributo", "value": "valor"}],
  "seo_keyword": "palabra clave principal",
  "seo_title": "título SEO (máx 60 caracteres)",
  "seo_description": "meta descripción (máx 155 caracteres)"
}`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text_response = message.content[0].text.trim();
    const jsonMatch = text_response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Respuesta inválida de IA');
    const data = JSON.parse(jsonMatch[0]);
    res.json(data);
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'Error IA: ' + err.message });
  }
});

// POST /api/ai/generate-specs - generar especificaciones técnicas desde nombre
router.post('/generate-specs', authMiddleware, async (req, res) => {
  const { product_name, category, brand, model, text } = req.body;
  if (!product_name && !text) return res.status(400).json({ error: 'Se requiere nombre o texto del producto' });

  try {
    const client = getClient();
    const prompt = `Eres un experto técnico en productos eléctricos e industriales.

Genera especificaciones técnicas detalladas para:
${product_name ? `Producto: ${product_name}` : ''}
${model ? `Modelo: ${model}` : ''}
${brand ? `Marca: ${brand}` : ''}
${category ? `Categoría: ${category}` : ''}
${text ? `Información adicional:\n${text.substring(0, 2000)}` : ''}

Responde ÚNICAMENTE con JSON válido:
{
  "specs": [
    {"name": "Voltaje de entrada", "value": "110/220V AC"},
    {"name": "Potencia nominal", "value": "1500W"}
  ],
  "datasheet_summary": "Resumen técnico del producto en 2-3 oraciones"
}

Incluye 8-12 especificaciones técnicas relevantes con unidades del SI.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    const jsonMatch = message.content[0].text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Respuesta inválida de IA');
    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('Specs AI error:', err);
    res.status(500).json({ error: 'Error generando especificaciones: ' + err.message });
  }
});

// POST /api/ai/parse-datasheet - extraer texto de PDF
router.post('/parse-datasheet', authMiddleware, uploadDatasheet.single('datasheet'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const buffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(buffer);
    fs.unlinkSync(req.file.path);
    res.json({ text: data.text.substring(0, 5000), pages: data.numpages, info: data.info });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: 'Error leyendo el PDF: ' + err.message });
  }
});

// POST /api/ai/seo
router.post('/seo', authMiddleware, async (req, res) => {
  const { name, description, category, brand } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });

  try {
    const client = getClient();
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Genera SEO optimizado en español para este producto eléctrico/industrial:
Nombre: ${name}
${brand ? `Marca: ${brand}` : ''}
${category ? `Categoría: ${category}` : ''}
${description ? `Descripción: ${description.substring(0, 500)}` : ''}

Responde SOLO con JSON:
{"seo_keyword":"...","seo_title":"...","seo_description":"..."}`
      }]
    });

    const jsonMatch = message.content[0].text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Respuesta inválida');
    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    res.status(500).json({ error: 'Error generando SEO: ' + err.message });
  }
});

// POST /api/ai/search-youtube
router.post('/search-youtube', authMiddleware, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query requerido' });
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  res.json({ search_url: searchUrl, query });
});

module.exports = router;
