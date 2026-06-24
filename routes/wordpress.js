const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

const SECRET_MASK = '••••••••';

function normalizeUrl(url) {
  if (!url) return '';

  let clean = String(url).trim();

  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'https://' + clean;
  }

  clean = clean.replace(/\/+$/, '');

  return clean;
}

function getSetting(db, key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value || fallback || '';
  } catch (error) {
    return fallback || '';
  }
}

function saveSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value || '');
}

function getWooConfig(overrides = {}) {
  const db = getDb();

  const savedUrl = getSetting(db, 'wc_url', process.env.WC_URL || '');
  const savedKey = getSetting(db, 'wc_key', process.env.WC_KEY || '');
  const savedSecret = getSetting(db, 'wc_secret', process.env.WC_SECRET || '');

  const url = normalizeUrl(overrides.wc_url || overrides.url || savedUrl);
  const key = String(overrides.wc_key || overrides.key || savedKey || '').trim();

  let secret = overrides.wc_secret || overrides.secret || savedSecret || '';

  if (secret === SECRET_MASK) {
    secret = savedSecret;
  }

  secret = String(secret || '').trim();

  return {
    url,
    key,
    secret
  };
}

function validateWooConfig(config) {
  if (!config.url) {
    return 'Falta la URL del sitio WooCommerce.';
  }

  if (!config.key) {
    return 'Falta el Consumer Key de WooCommerce.';
  }

  if (!config.secret) {
    return 'Falta el Consumer Secret de WooCommerce.';
  }

  if (!config.key.startsWith('ck_')) {
    return 'El Consumer Key debe empezar con ck_.';
  }

  if (!config.secret.startsWith('cs_')) {
    return 'El Consumer Secret debe empezar con cs_.';
  }

  return null;
}

function wooBaseUrl(config) {
  return `${config.url}/wp-json/wc/v3`;
}

async function wooRequest(config, method, endpoint, options = {}) {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const baseURL = wooBaseUrl(config);

  const requestOptions = {
    method,
    url: cleanEndpoint,
    baseURL,
    timeout: 30000,
    params: options.params || {},
    data: options.data,
    headers: options.headers || {},
    auth: {
      username: config.key,
      password: config.secret
    }
  };

  try {
    return await axios(requestOptions);
  } catch (firstError) {
    const message = firstError.response?.data?.message || firstError.message || '';
    const code = firstError.response?.data?.code || '';

    const shouldTryQueryAuth =
      firstError.response?.status === 401 ||
      firstError.response?.status === 403 ||
      message.toLowerCase().includes('consumer key') ||
      message.toLowerCase().includes('signature') ||
      code.toLowerCase().includes('woocommerce_rest');

    if (!shouldTryQueryAuth) {
      throw firstError;
    }

    const fallbackOptions = {
      ...requestOptions,
      auth: undefined,
      params: {
        ...(options.params || {}),
        consumer_key: config.key,
        consumer_secret: config.secret
      }
    };

    return await axios(fallbackOptions);
  }
}

async function wooGet(config, endpoint, params = {}) {
  return wooRequest(config, 'GET', endpoint, { params });
}

async function wooPost(config, endpoint, data = {}) {
  return wooRequest(config, 'POST', endpoint, { data });
}

async function wooPut(config, endpoint, data = {}) {
  return wooRequest(config, 'PUT', endpoint, { data });
}

function cleanWooError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  const message = data?.message || err.message || 'Error desconocido';

  if (status === 401) {
    return 'Error 401: WooCommerce rechazó las credenciales. Revisa que el Consumer Key y Consumer Secret sean correctos y tengan permiso Read/Write.';
  }

  if (status === 403) {
    return 'Error 403: el usuario de la API no tiene permisos suficientes o el servidor bloqueó la autenticación.';
  }

  if (status === 404) {
    return 'Error 404: no se encontró la ruta de WooCommerce. Revisa que WooCommerce esté activo y que la URL del sitio sea correcta.';
  }

  return `Error WooCommerce: ${message}`;
}

// GET /api/wordpress/config
router.get('/config', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const config = getWooConfig();

    res.json({
      wc_url: config.url,
      wc_key: config.key,
      wc_secret: config.secret ? SECRET_MASK : ''
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando configuración WooCommerce: ' + error.message
    });
  }
});

// PUT /api/wordpress/config
router.put('/config', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const db = getDb();
    const current = getWooConfig();

    const wcUrl = normalizeUrl(req.body.wc_url || req.body.url || current.url);
    const wcKey = String(req.body.wc_key || req.body.key || current.key || '').trim();

    let wcSecret = req.body.wc_secret || req.body.secret || current.secret || '';

    if (wcSecret === SECRET_MASK) {
      wcSecret = current.secret;
    }

    wcSecret = String(wcSecret || '').trim();

    saveSetting(db, 'wc_url', wcUrl);
    saveSetting(db, 'wc_key', wcKey);
    saveSetting(db, 'wc_secret', wcSecret);

    res.json({
      success: true,
      message: 'Configuración WooCommerce guardada correctamente',
      config: {
        wc_url: wcUrl,
        wc_key: wcKey,
        wc_secret: wcSecret ? SECRET_MASK : ''
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error guardando WooCommerce: ' + error.message
    });
  }
});

// POST /api/wordpress/test
router.post('/test', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const config = getWooConfig(req.body || {});
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError
    });
  }

  try {
    const response = await wooGet(config, '/products', {
      per_page: 1
    });

    const totalProducts = response.headers['x-wp-total'] || '?';

    res.json({
      success: true,
      message: `Conexión exitosa. WooCommerce respondió correctamente. Productos detectados: ${totalProducts}.`,
      site: config.url
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

// POST /api/wordpress/sync-categories
router.post('/sync-categories', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const db = getDb();
    const { data } = await wooGet(config, '/products/categories', {
      per_page: 100,
      hide_empty: false
    });

    const stmt = db.prepare('INSERT OR IGNORE INTO categories (name, slug, wp_id) VALUES (?, ?, ?)');

    let added = 0;

    data.forEach((cat) => {
      try {
        stmt.run(cat.name, cat.slug, cat.id);
        added++;
      } catch (error) {}
    });

    res.json({
      success: true,
      message: `${added} categorías importadas desde WooCommerce`,
      total: data.length
    });
  } catch (err) {
    res.status(400).json({
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

// POST /api/wordpress/sync-brands
router.post('/sync-brands', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const db = getDb();
    const attrsRes = await wooGet(config, '/products/attributes', {
      per_page: 100
    });

    const brandAttr = attrsRes.data.find((attr) => {
      const slug = String(attr.slug || '').toLowerCase();
      const name = String(attr.name || '').toLowerCase();

      return ['marca', 'brand', 'fabricante'].includes(slug) || name.includes('marca') || name.includes('brand');
    });

    let brands = [];

    if (brandAttr) {
      const termsRes = await wooGet(config, `/products/attributes/${brandAttr.id}/terms`, {
        per_page: 100
      });

      brands = termsRes.data.map((term) => ({
        name: term.name,
        slug: term.slug
      }));
    }

    const stmt = db.prepare('INSERT OR IGNORE INTO brands (name, slug) VALUES (?, ?)');

    let added = 0;

    brands.forEach((brand) => {
      try {
        stmt.run(brand.name, brand.slug);
        added++;
      } catch (error) {}
    });

    res.json({
      success: true,
      message: `${added} marcas importadas desde WooCommerce`,
      total: brands.length
    });
  } catch (err) {
    res.status(400).json({
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

// POST /api/wordpress/sync-attributes
router.post('/sync-attributes', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const db = getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS attribute_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        unit TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const { data } = await wooGet(config, '/products/attributes', {
      per_page: 100
    });

    const stmt = db.prepare('INSERT OR IGNORE INTO attribute_templates (name, unit) VALUES (?, ?)');

    let added = 0;

    data.forEach((attr) => {
      const unitMatch = String(attr.name || '').match(/\(([^)]+)\)$/);
      const unit = unitMatch ? unitMatch[1] : '';
      const cleanName = String(attr.name || '').replace(/\s*\([^)]+\)$/, '').trim();

      try {
        stmt.run(cleanName, unit);
        added++;
      } catch (error) {}
    });

    res.json({
      success: true,
      message: `${added} atributos importados desde WooCommerce`,
      total: data.length
    });
  } catch (err) {
    res.status(400).json({
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

// POST /api/wordpress/publish/:id
router.post('/publish/:id', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const db = getDb();
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const product = db
    .prepare(`
      SELECT
        p.*,
        c.wp_id AS category_wp_id
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?
    `)
    .get(req.params.id);

  if (!product) {
    return res.status(404).json({
      error: 'Producto no encontrado'
    });
  }

  const images = db
    .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY is_main DESC, sort_order')
    .all(req.params.id);

  const attributes = db
    .prepare('SELECT * FROM product_attributes WHERE product_id = ?')
    .all(req.params.id);

  try {
    const wpImages = [];

    for (const img of images) {
      try {
        const imgPath = path.join(__dirname, '..', 'uploads', 'images', img.filename);

        if (!fs.existsSync(imgPath)) continue;

        const form = new FormData();
        form.append('file', fs.createReadStream(imgPath), img.filename);

        const mediaRes = await axios.post(`${config.url}/wp-json/wp/v2/media`, form, {
          headers: form.getHeaders(),
          auth: {
            username: config.key,
            password: config.secret
          },
          timeout: 30000
        });

        wpImages.push({
          id: mediaRes.data.id,
          src: mediaRes.data.source_url
        });
      } catch (error) {
        console.error('Error subiendo imagen a WordPress:', error.response?.data || error.message);
      }
    }

    const productData = {
      name: product.name,
      type: product.type || 'simple',
      status: 'publish',
      description: product.description || '',
      short_description: product.short_description || '',
      sku: product.sku || '',
      regular_price: String(product.price || 0),
      sale_price: product.sale_price ? String(product.sale_price) : '',
      manage_stock: true,
      stock_quantity: product.stock_quantity || 0,
      stock_status: product.stock_status || 'instock',
      images: wpImages,
      attributes: attributes.map((attr) => ({
        name: attr.name,
        options: [attr.value],
        visible: true
      })),
      categories: product.category_wp_id ? [{ id: product.category_wp_id }] : []
    };

    let response;

    if (product.wp_product_id) {
      response = await wooPut(config, `/products/${product.wp_product_id}`, productData);
    } else {
      response = await wooPost(config, '/products', productData);
    }

    db.prepare('UPDATE products SET wp_product_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(response.data.id, 'published', req.params.id);

    res.json({
      success: true,
      message: 'Producto publicado correctamente en WooCommerce',
      wp_product_id: response.data.id,
      wp_url: response.data.permalink
    });
  } catch (err) {
    res.status(400).json({
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

module.exports = router;
