const express = require('express');
const axios = require('axios');

const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v22.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'reelectrosistemas_verify_token_2026';

const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

function hasWhatsappConfig() {
  return Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN);
}

function cleanPhone(rawPhone = '') {
  return String(rawPhone || '')
    .replace(/[^\d]/g, '')
    .replace(/^00/, '');
}

function normalizeDominicanPhone(rawPhone = '') {
  let phone = cleanPhone(rawPhone);

  if (!phone) return '';

  if (phone.length === 10 && phone.startsWith('8')) {
    phone = `1${phone}`;
  }

  if (phone.length === 10 && phone.startsWith('9')) {
    phone = `1${phone}`;
  }

  if (phone.length === 10 && phone.startsWith('7')) {
    phone = `1${phone}`;
  }

  return phone;
}

function formatMoney(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n) || n <= 0) {
    return 'Precio a consultar';
  }

  return `RD$ ${n.toLocaleString('es-DO')}`;
}

function getProductPrice(product = {}, priceMode = 'auto') {
  const normal = Number(product.regular_price || product.price || product.normal_price || 0);
  const offer = Number(product.sale_price || product.offer_price || 0);

  if (priceMode === 'normal') {
    return normal || offer || 0;
  }

  if (priceMode === 'offer') {
    return offer || normal || 0;
  }

  return offer || normal || 0;
}

function buildProductCaption(product = {}, priceMode = 'auto') {
  const price = getProductPrice(product, priceMode);

  return [
    `*${product.name || 'Producto disponible'}*`,
    product.sku ? `SKU: ${product.sku}` : '',
    product.model ? `Modelo: ${product.model}` : '',
    `Precio: ${formatMoney(price)}`,
    product.product_url || product.public_url || product.url
      ? `Ver producto: ${product.product_url || product.public_url || product.url}`
      : ''
  ].filter(Boolean).join('\n');
}

async function sendWhatsApp(payload) {
  if (!hasWhatsappConfig()) {
    const error = new Error('WhatsApp API no está configurado. Faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN.');
    error.statusCode = 400;
    throw error;
  }

  const url = `${GRAPH_BASE_URL}/${PHONE_NUMBER_ID}/messages`;

  const response = await axios.post(url, payload, {
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

async function sendTextMessage(to, text) {
  return sendWhatsApp({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: {
      preview_url: true,
      body: text
    }
  });
}

async function sendImageMessage(to, imageUrl, caption = '') {
  return sendWhatsApp({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: {
      link: imageUrl,
      caption
    }
  });
}

// GET /api/whatsapp/status
router.get('/status', authMiddleware, (req, res) => {
  res.json({
    connected: hasWhatsappConfig(),
    graph_version: GRAPH_VERSION,
    phone_number_id_configured: Boolean(PHONE_NUMBER_ID),
    access_token_configured: Boolean(ACCESS_TOKEN),
    verify_token_configured: Boolean(VERIFY_TOKEN),
    mode: 'cloud_api'
  });
});

// POST /api/whatsapp/send-text
router.post('/send-text', authMiddleware, async (req, res) => {
  try {
    const to = normalizeDominicanPhone(req.body.to);
    const message = String(req.body.message || '').trim();

    if (!to) {
      return res.status(400).json({
        error: 'Número de WhatsApp requerido.'
      });
    }

    if (!message) {
      return res.status(400).json({
        error: 'Mensaje requerido.'
      });
    }

    const result = await sendTextMessage(to, message);

    res.json({
      success: true,
      to,
      result
    });
  } catch (error) {
    console.error('[whatsapp] send-text error:', error.response?.data || error.message);

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.response?.data?.error?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// POST /api/whatsapp/send-image
router.post('/send-image', authMiddleware, async (req, res) => {
  try {
    const to = normalizeDominicanPhone(req.body.to);
    const imageUrl = String(req.body.image_url || req.body.imageUrl || '').trim();
    const caption = String(req.body.caption || '').trim();

    if (!to) {
      return res.status(400).json({
        error: 'Número de WhatsApp requerido.'
      });
    }

    if (!imageUrl || !imageUrl.startsWith('http')) {
      return res.status(400).json({
        error: 'URL pública de imagen requerida.'
      });
    }

    const result = await sendImageMessage(to, imageUrl, caption);

    res.json({
      success: true,
      to,
      image_url: imageUrl,
      result
    });
  } catch (error) {
    console.error('[whatsapp] send-image error:', error.response?.data || error.message);

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.response?.data?.error?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// POST /api/whatsapp/send-products
router.post('/send-products', authMiddleware, async (req, res) => {
  try {
    const to = normalizeDominicanPhone(req.body.to);
    const customerName = String(req.body.customer_name || req.body.customerName || '').trim();
    const priceMode = req.body.price_mode || req.body.priceMode || 'auto';
    const products = Array.isArray(req.body.products) ? req.body.products : [];

    if (!to) {
      return res.status(400).json({
        error: 'Número de WhatsApp requerido.'
      });
    }

    if (!products.length) {
      return res.status(400).json({
        error: 'Debes enviar al menos un producto.'
      });
    }

    const results = [];

    const intro = [
      customerName ? `Hola ${customerName},` : 'Hola,',
      'te comparto la información del producto solicitado:'
    ].join('\n');

    const introResult = await sendTextMessage(to, intro);

    results.push({
      type: 'intro',
      result: introResult
    });

    for (const product of products) {
      const caption = buildProductCaption(product, priceMode);
      const imageUrl = product.image_url || product.image || product.main_image_url || '';

      if (imageUrl && String(imageUrl).startsWith('http')) {
        const imageResult = await sendImageMessage(to, imageUrl, caption);

        results.push({
          type: 'image',
          product: product.name || '',
          result: imageResult
        });
      } else {
        const textResult = await sendTextMessage(to, caption);

        results.push({
          type: 'text',
          product: product.name || '',
          result: textResult
        });
      }
    }

    const closingResult = await sendTextMessage(
      to,
      'Quedo atento para ayudarte. Si deseas avanzar, puedo prepararte una cotización u orden con estos productos.'
    );

    results.push({
      type: 'closing',
      result: closingResult
    });

    res.json({
      success: true,
      to,
      customer_name: customerName,
      sent_products: products.length,
      results
    });
  } catch (error) {
    console.error('[whatsapp] send-products error:', error.response?.data || error.message);

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.response?.data?.error?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// GET /api/whatsapp/webhook
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// POST /api/whatsapp/webhook
router.post('/webhook', express.json({ type: '*/*' }), (req, res) => {
  try {
    console.log('[whatsapp webhook]', JSON.stringify(req.body, null, 2));

    // Aquí luego guardamos mensajes entrantes en:
    // - inbox
    // - clientes
    // - notificaciones
    // - asignación al usuario disponible

    res.sendStatus(200);
  } catch (error) {
    console.error('[whatsapp webhook] error:', error);

    res.sendStatus(200);
  }
});

module.exports = router;
