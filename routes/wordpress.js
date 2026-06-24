const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
const SECRET_MASK = '••••••••';

const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BACKEND_URL || 'https://ree-backend-production.up.railway.app');

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT,
      parent_id INTEGER,
      wp_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      logo TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      short_description TEXT,
      description TEXT,
      brand_id INTEGER,
      category_id INTEGER,
      model TEXT,
      type TEXT DEFAULT 'simple',
      sku TEXT,
      price REAL,
      sale_price REAL,
      stock_quantity INTEGER DEFAULT 0,
      stock_status TEXT DEFAULT 'instock',
      youtube_url TEXT,
      pdf_filename TEXT,
      seo_keyword TEXT,
      seo_title TEXT,
      seo_description TEXT,
      status TEXT DEFAULT 'draft',
      wp_product_id INTEGER,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      is_main INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_attributes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

function normalizeUrl(url) {
  if (!url) return '';
  let clean = String(url).trim();
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) clean = 'https://' + clean;
  return clean.replace(/\/+$/, '');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sin-slug';
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
  ensureSchema(db);

  let legacy = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'woocommerce_config'").get();
    legacy = row?.value ? JSON.parse(row.value) : {};
  } catch (error) {
    legacy = {};
  }

  const savedUrl = getSetting(db, 'wc_url', legacy.woo_url || legacy.wc_url || process.env.WC_URL || '');
  const savedKey = getSetting(db, 'wc_key', legacy.woo_key || legacy.wc_key || process.env.WC_KEY || '');
  const savedSecret = getSetting(db, 'wc_secret', legacy.woo_secret || legacy.wc_secret || process.env.WC_SECRET || '');

  const url = normalizeUrl(overrides.wc_url || overrides.woo_url || overrides.url || savedUrl);
  const key = String(overrides.wc_key || overrides.woo_key || overrides.key || savedKey || '').trim();
  let secret = overrides.wc_secret || overrides.woo_secret || overrides.secret || savedSecret || '';
  if (secret === SECRET_MASK || secret === '***') secret = savedSecret;
  secret = String(secret || '').trim();

  return { url, key, secret };
}

function saveWooConfig(body = {}) {
  const db = getDb();
  ensureSchema(db);
  const current = getWooConfig();

  const url = normalizeUrl(body.wc_url || body.woo_url || body.url || current.url);
  const key = String(body.wc_key || body.woo_key || body.key || current.key || '').trim();
  let secret = body.wc_secret || body.woo_secret || body.secret || current.secret || '';
  if (secret === SECRET_MASK || secret === '***') secret = current.secret;
  secret = String(secret || '').trim();

  saveSetting(db, 'wc_url', url);
  saveSetting(db, 'wc_key', key);
  saveSetting(db, 'wc_secret', secret);
  saveSetting(db, 'woocommerce_config', JSON.stringify({ woo_url: url, woo_key: key, woo_secret: secret }));

  return { url, key, secret };
}

function validateWooConfig(config) {
  if (!config.url) return 'Falta la URL del sitio WooCommerce.';
  if (!config.key) return 'Falta el Consumer Key de WooCommerce.';
  if (!config.secret) return 'Falta el Consumer Secret de WooCommerce.';
  if (!config.key.startsWith('ck_')) return 'El Consumer Key debe empezar con ck_.';
  if (!config.secret.startsWith('cs_')) return 'El Consumer Secret debe empezar con cs_.';
  return null;
}

async function wooRequest(config, method, endpoint, options = {}) {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const baseURL = `${config.url}/wp-json/wc/v3`;

  const requestOptions = {
    method,
    baseURL,
    url: cleanEndpoint,
    timeout: 45000,
    params: options.params || {},
    data: options.data,
    headers: options.headers || {},
    auth: { username: config.key, password: config.secret }
  };

  try {
    return await axios(requestOptions);
  } catch (firstError) {
    const status = firstError.response?.status;
    const message = String(firstError.response?.data?.message || firstError.message || '').toLowerCase();
    const shouldTryQueryAuth = status === 401 || status === 403 || message.includes('consumer') || message.includes('signature');
    if (!shouldTryQueryAuth) throw firstError;

    return await axios({
      ...requestOptions,
      auth: undefined,
      params: {
        ...(options.params || {}),
        consumer_key: config.key,
        consumer_secret: config.secret
      }
    });
  }
}

function cleanWooError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  const message = data?.message || err.message || 'Error desconocido';
  if (status === 401) return 'Error 401: WooCommerce rechazó las credenciales. Revisa Consumer Key y Consumer Secret con permiso Read/Write.';
  if (status === 403) return 'Error 403: el servidor bloqueó la autenticación o el usuario no tiene permisos suficientes.';
  if (status === 404) return 'Error 404: no se encontró WooCommerce. Revisa que WooCommerce esté activo y la URL sea correcta.';
  return `Error WooCommerce: ${message}`;
}

async function getAllWooProducts(config, status = 'any') {
  const all = [];
  let page = 1;

  while (true) {
    const { data } = await wooRequest(config, 'GET', '/products', {
      params: {
        per_page: 100,
        page,
        status,
        orderby: 'date',
        order: 'desc'
      }
    });

    if (!Array.isArray(data) || data.length === 0) break;

    all.push(...data);

    if (data.length < 100) break;

    page += 1;
  }

  return all;
}

async function getWooProduct(config, id) {
  const { data } = await wooRequest(config, 'GET', `/products/${id}`);
  return data;
}

function getLocalProducts(db) {
  ensureSchema(db);

  return db.prepare(`
    SELECT
      p.*,
      b.name AS brand_name,
      c.name AS category_name,
      (
        SELECT filename
        FROM product_images
        WHERE product_id = p.id AND is_main = 1
        LIMIT 1
      ) AS main_image
    FROM products p
    LEFT JOIN brands b ON p.brand_id = b.id
    LEFT JOIN categories c ON p.category_id = c.id
    ORDER BY p.updated_at DESC
  `).all();
}

function findLocalMatch(wooProduct, localProducts) {
  const byWp = localProducts.find((p) => Number(p.wp_product_id || 0) === Number(wooProduct.id));
  if (byWp) return { product: byWp, match_type: 'wp_product_id' };

  if (wooProduct.sku) {
    const bySku = localProducts.find((p) => String(p.sku || '').trim().toLowerCase() === String(wooProduct.sku).trim().toLowerCase());
    if (bySku) return { product: bySku, match_type: 'sku' };
  }

  const byName = localProducts.find((p) => String(p.name || '').trim().toLowerCase() === String(wooProduct.name || '').trim().toLowerCase());
  if (byName) return { product: byName, match_type: 'name' };

  return { product: null, match_type: '' };
}

function wooProductToRow(wooProduct, localMatch) {
  const local = localMatch.product;
  const wooImage = Array.isArray(wooProduct.images) && wooProduct.images[0] ? wooProduct.images[0].src : '';
  const inSystem = !!local;
  const linked = !!local && Number(local.wp_product_id || 0) === Number(wooProduct.id);
  const onlyWoo = !inSystem;
  const needsUpdate = !!local && (
    String(local.name || '') !== String(wooProduct.name || '') ||
    String(local.price || '') !== String(wooProduct.regular_price || wooProduct.price || '') ||
    String(local.sale_price || '') !== String(wooProduct.sale_price || '') ||
    String(local.stock_status || '') !== String(wooProduct.stock_status || '')
  );

  return {
    source: 'woocommerce',
    woo_id: wooProduct.id,
    local_id: local?.id || null,
    match_type: localMatch.match_type || '',
    in_system: inSystem,
    linked,
    only_woocommerce: onlyWoo,
    needs_update: needsUpdate,
    suggested_action: onlyWoo ? 'import' : needsUpdate ? 'update' : 'ok',
    name: wooProduct.name || '',
    sku: wooProduct.sku || '',
    type: wooProduct.type || 'simple',
    status: wooProduct.status || '',
    price: wooProduct.regular_price || wooProduct.price || '',
    sale_price: wooProduct.sale_price || '',
    stock_quantity: wooProduct.stock_quantity || 0,
    stock_status: wooProduct.stock_status || '',
    permalink: wooProduct.permalink || '',
    image: wooImage,
    local_status: local?.status || '',
    local_name: local?.name || '',
    local_main_image: local?.main_image || ''
  };
}

function filterRows(rows, filter, search) {
  let filtered = rows;

  if (filter === 'in_system') filtered = filtered.filter((r) => r.in_system);
  if (filter === 'only_woocommerce' || filter === 'not_in_system' || filter === 'missing') filtered = filtered.filter((r) => r.only_woocommerce);
  if (filter === 'linked') filtered = filtered.filter((r) => r.linked);
  if (filter === 'needs_update') filtered = filtered.filter((r) => r.needs_update);

  const q = String(search || '').trim().toLowerCase();

  if (q) {
    filtered = filtered.filter((r) => [r.name, r.sku, r.local_name].some((v) => String(v || '').toLowerCase().includes(q)));
  }

  return filtered;
}

function getOrCreateCategory(db, wooCategory) {
  if (!wooCategory) return null;

  const wpId = Number(wooCategory.id || 0);
  let row = null;

  if (wpId) row = db.prepare('SELECT id FROM categories WHERE wp_id = ?').get(wpId);
  if (!row) row = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)').get(wooCategory.name || '');

  if (row) {
    if (wpId) {
      db.prepare('UPDATE categories SET wp_id = ?, slug = ? WHERE id = ?')
        .run(wpId, wooCategory.slug || slugify(wooCategory.name), row.id);
    }

    return row.id;
  }

  const result = db.prepare('INSERT INTO categories (name, slug, wp_id) VALUES (?, ?, ?)')
    .run(wooCategory.name || 'Sin categoría', wooCategory.slug || slugify(wooCategory.name), wpId || null);

  return result.lastInsertRowid;
}

function getOrCreateBrand(db, wooProduct) {
  const attrs = Array.isArray(wooProduct.attributes) ? wooProduct.attributes : [];

  const brandAttr = attrs.find((attr) => {
    const name = String(attr.name || '').toLowerCase();
    const slug = String(attr.slug || '').toLowerCase();

    return name.includes('marca') || name.includes('brand') || slug.includes('marca') || slug.includes('brand');
  });

  const brandName = brandAttr && Array.isArray(brandAttr.options) ? brandAttr.options[0] : '';

  if (!brandName) return null;

  let row = db.prepare('SELECT id FROM brands WHERE LOWER(name) = LOWER(?)').get(brandName);
  if (row) return row.id;

  const result = db.prepare('INSERT INTO brands (name) VALUES (?)').run(brandName);
  return result.lastInsertRowid;
}

async function downloadWooImageIfNeeded(imageUrl, wooId) {
  if (!imageUrl) return null;

  try {
    const imagesDir = path.join(__dirname, '..', 'uploads', 'images');

    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

    const hash = crypto.createHash('md5').update(imageUrl).digest('hex').slice(0, 10);
    const cleanExt = path.extname(new URL(imageUrl).pathname).replace(/[^a-zA-Z0-9.]/g, '') || '.jpg';
    const ext = ['.jpg', '.jpeg', '.png', '.webp'].includes(cleanExt.toLowerCase()) ? cleanExt : '.jpg';
    const filename = `woo_${wooId}_${hash}${ext}`;
    const filepath = path.join(imagesDir, filename);

    if (fs.existsSync(filepath)) return filename;

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    fs.writeFileSync(filepath, response.data);

    return filename;
  } catch (error) {
    console.error('No se pudo descargar imagen Woo:', error.message);
    return null;
  }
}

async function upsertWooProduct(db, wooProduct, userId, options = {}) {
  const localProducts = getLocalProducts(db);
  const match = findLocalMatch(wooProduct, localProducts);
  const existing = match.product;
  const firstCategory = Array.isArray(wooProduct.categories) && wooProduct.categories[0] ? wooProduct.categories[0] : null;
  const categoryId = getOrCreateCategory(db, firstCategory);
  const brandId = getOrCreateBrand(db, wooProduct);
  const regularPrice = Number(wooProduct.regular_price || wooProduct.price || 0) || 0;
  const salePrice = wooProduct.sale_price ? Number(wooProduct.sale_price) || null : null;
  const importedStatus = options.local_status || 'published';

  let productId;

  if (existing) {
    db.prepare(`
      UPDATE products
      SET
        name = ?,
        short_description = ?,
        description = ?,
        brand_id = COALESCE(?, brand_id),
        category_id = COALESCE(?, category_id),
        model = ?,
        type = ?,
        sku = ?,
        price = ?,
        sale_price = ?,
        stock_quantity = ?,
        stock_status = ?,
        status = ?,
        wp_product_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      wooProduct.name || existing.name,
      wooProduct.short_description || '',
      wooProduct.description || '',
      brandId,
      categoryId,
      wooProduct.sku || existing.model || '',
      wooProduct.type || 'simple',
      wooProduct.sku || '',
      regularPrice,
      salePrice,
      wooProduct.stock_quantity || 0,
      wooProduct.stock_status || 'instock',
      importedStatus,
      wooProduct.id,
      existing.id
    );

    productId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO products (
        name,
        short_description,
        description,
        brand_id,
        category_id,
        model,
        type,
        sku,
        price,
        sale_price,
        stock_quantity,
        stock_status,
        youtube_url,
        seo_keyword,
        seo_title,
        seo_description,
        status,
        wp_product_id,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wooProduct.name || 'Producto WooCommerce',
      wooProduct.short_description || '',
      wooProduct.description || '',
      brandId,
      categoryId,
      wooProduct.sku || '',
      wooProduct.type || 'simple',
      wooProduct.sku || '',
      regularPrice,
      salePrice,
      wooProduct.stock_quantity || 0,
      wooProduct.stock_status || 'instock',
      '',
      wooProduct.name || '',
      wooProduct.name || '',
      String(wooProduct.short_description || '').replace(/<[^>]+>/g, '').slice(0, 155),
      importedStatus,
      wooProduct.id,
      userId || null
    );

    productId = result.lastInsertRowid;
  }

  db.prepare('DELETE FROM product_attributes WHERE product_id = ?').run(productId);

  const attrStmt = db.prepare('INSERT INTO product_attributes (product_id, name, value) VALUES (?, ?, ?)');

  (wooProduct.attributes || []).forEach((attr) => {
    const value = Array.isArray(attr.options) ? attr.options.join(', ') : String(attr.option || attr.value || '');
    if (attr.name && value) attrStmt.run(productId, attr.name, value);
  });

  const mainImageUrl = Array.isArray(wooProduct.images) && wooProduct.images[0] ? wooProduct.images[0].src : '';
  const filename = await downloadWooImageIfNeeded(mainImageUrl, wooProduct.id);

  if (filename) {
    const existsImage = db.prepare('SELECT id FROM product_images WHERE product_id = ? AND filename = ?').get(productId, filename);

    if (!existsImage) {
      db.prepare('UPDATE product_images SET is_main = 0 WHERE product_id = ?').run(productId);
      db.prepare('INSERT INTO product_images (product_id, filename, is_main, sort_order) VALUES (?, ?, 1, 0)')
        .run(productId, filename);
    }
  }

  return {
    product_id: productId,
    woo_id: wooProduct.id,
    updated: !!existing
  };
}

async function publishLocalProductToWoo(config, db, product) {
  const images = db.prepare('SELECT filename FROM product_images WHERE product_id = ? ORDER BY is_main DESC, sort_order ASC').all(product.id);
  const attrs = db.prepare('SELECT name, value FROM product_attributes WHERE product_id = ?').all(product.id);
  const category = product.category_wp_id ? [{ id: product.category_wp_id }] : [];

  const productData = {
    name: product.name,
    type: product.type || 'simple',
    status: 'publish',
    description: product.description || '',
    short_description: product.short_description || '',
    sku: product.sku || undefined,
    regular_price: String(product.price || 0),
    sale_price: product.sale_price ? String(product.sale_price) : undefined,
    manage_stock: true,
    stock_quantity: product.stock_quantity || 0,
    stock_status: product.stock_status || 'instock',
    categories: category,
    attributes: attrs.map((attr) => ({
      name: attr.name,
      options: [attr.value],
      visible: true
    })),
    images: images.map((img) => ({
      src: `${BACKEND_URL}/uploads/images/${img.filename}`
    }))
  };

  let response;

  if (product.wp_product_id) {
    response = await wooRequest(config, 'PUT', `/products/${product.wp_product_id}`, { data: productData });
  } else {
    response = await wooRequest(config, 'POST', '/products', { data: productData });
  }

  return response.data;
}

router.get('/status', authMiddleware, (req, res) => {
  try {
    const config = getWooConfig();
    const validationError = validateWooConfig(config);

    res.json({
      connected: !validationError,
      configured: !validationError,
      wc_url: config.url || null,
      woo_url: config.url || null,
      has_key: !!config.key,
      has_secret: !!config.secret,
      message: validationError || 'WooCommerce configurado.'
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

router.get('/config', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const config = getWooConfig();

    res.json({
      wc_url: config.url,
      woo_url: config.url,
      wc_key: config.key,
      woo_key: config.key,
      wc_secret: config.secret ? SECRET_MASK : '',
      woo_secret: config.secret ? SECRET_MASK : ''
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

router.put('/config', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const config = saveWooConfig(req.body || {});
    const validationError = validateWooConfig(config);

    if (validationError) {
      return res.status(400).json({
        success: false,
        error: validationError
      });
    }

    res.json({
      success: true,
      message: 'Configuración WooCommerce guardada.',
      wc_url: config.url
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.post('/config', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const config = saveWooConfig(req.body || {});
    const validationError = validateWooConfig(config);

    if (validationError) {
      return res.status(400).json({
        success: false,
        error: validationError
      });
    }

    await wooRequest(config, 'GET', '/products', {
      params: {
        per_page: 1
      }
    });

    res.json({
      success: true,
      message: 'Conexión exitosa. Configuración guardada.',
      wc_url: config.url
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: cleanWooError(err)
    });
  }
});

router.post('/test', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const config = getWooConfig(req.body || {});
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError
    });
  }

  try {
    const response = await wooRequest(config, 'GET', '/products', {
      params: {
        per_page: 1
      }
    });

    res.json({
      success: true,
      message: `Conexión exitosa. Productos detectados: ${response.headers['x-wp-total'] || '?'}.`,
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

router.get('/preview-products', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      connected: false,
      error: validationError
    });
  }

  try {
    const db = getDb();
    ensureSchema(db);

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
    const filter = req.query.filter || 'all';
    const search = req.query.search || '';

    const wooProducts = await getAllWooProducts(config, req.query.status || 'any');
    const localProducts = getLocalProducts(db);
    const wooRows = wooProducts.map((wooProduct) => wooProductToRow(wooProduct, findLocalMatch(wooProduct, localProducts)));

    const wooIds = new Set(wooProducts.map((p) => Number(p.id)));

    const systemOnlyRows = localProducts
      .filter((p) => !p.wp_product_id || !wooIds.has(Number(p.wp_product_id)))
      .map((p) => ({
        source: 'system',
        woo_id: null,
        local_id: p.id,
        in_system: true,
        linked: false,
        only_woocommerce: false,
        only_system: true,
        needs_update: false,
        suggested_action: p.wp_product_id ? 'check' : 'publish_to_woo',
        name: p.name,
        sku: p.sku,
        status: '',
        price: p.price,
        sale_price: p.sale_price,
        stock_quantity: p.stock_quantity,
        stock_status: p.stock_status,
        image: p.main_image ? `${BACKEND_URL}/uploads/images/${p.main_image}` : '',
        local_status: p.status,
        local_name: p.name,
        local_main_image: p.main_image || ''
      }));

    let rows = filter === 'only_system' || filter === 'system_only'
      ? systemOnlyRows
      : filter === 'all_with_system'
        ? [...wooRows, ...systemOnlyRows]
        : wooRows;

    rows = filterRows(rows, filter, search);

    const total = rows.length;
    const paged = rows.slice((page - 1) * limit, page * limit);

    const stats = {
      total_woocommerce: wooRows.length,
      total_system: localProducts.length,
      linked: wooRows.filter((r) => r.linked).length,
      in_system: wooRows.filter((r) => r.in_system).length,
      only_woocommerce: wooRows.filter((r) => r.only_woocommerce).length,
      only_system: systemOnlyRows.length,
      needs_update: wooRows.filter((r) => r.needs_update).length
    };

    res.json({
      success: true,
      connected: true,
      stats,
      rows: paged,
      total,
      page,
      pages: Math.ceil(total / limit),
      limit
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      connected: false,
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

router.post('/sync-categories', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError
    });
  }

  try {
    const db = getDb();
    ensureSchema(db);

    let page = 1;
    let total = 0;

    while (true) {
      const { data } = await wooRequest(config, 'GET', '/products/categories', {
        params: {
          per_page: 100,
          page,
          hide_empty: false
        }
      });

      if (!Array.isArray(data) || data.length === 0) break;

      for (const cat of data) {
        getOrCreateCategory(db, cat);
        total += 1;
      }

      if (data.length < 100) break;

      page += 1;
    }

    res.json({
      success: true,
      message: `${total} categorías sincronizadas.`,
      total
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

router.post('/import-products', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError
    });
  }

  try {
    const db = getDb();
    ensureSchema(db);

    const mode = req.body?.mode || 'selected';
    const wooIds = Array.isArray(req.body?.woo_ids) ? req.body.woo_ids.map(Number).filter(Boolean) : [];
    const updateExisting = req.body?.update_existing !== false;

    let wooProducts = [];

    if (mode === 'all' || mode === 'missing' || mode === 'new') {
      wooProducts = await getAllWooProducts(config, req.body?.woo_status || 'any');
    } else {
      if (wooIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Selecciona al menos un producto.'
        });
      }

      for (const id of wooIds) {
        wooProducts.push(await getWooProduct(config, id));
      }
    }

    const localProducts = getLocalProducts(db);

    if (mode === 'missing' || mode === 'new') {
      wooProducts = wooProducts.filter((p) => !findLocalMatch(p, localProducts).product);
    }

    let imported = 0;
    let updated = 0;
    const errors = [];
    const results = [];

    for (const wooProduct of wooProducts) {
      try {
        const match = findLocalMatch(wooProduct, getLocalProducts(db));

        if (match.product && !updateExisting) continue;

        const result = await upsertWooProduct(db, wooProduct, req.user?.id || null, {
          local_status: 'published'
        });

        if (result.updated) updated += 1;
        else imported += 1;

        results.push(result);
      } catch (error) {
        errors.push({
          woo_id: wooProduct.id,
          name: wooProduct.name,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `${imported} productos importados, ${updated} actualizados${errors.length ? `, ${errors.length} con error` : ''}.`,
      imported,
      updated,
      errors,
      results
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

router.post('/sync-products', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError
    });
  }

  try {
    const db = getDb();
    ensureSchema(db);

    const wooProducts = await getAllWooProducts(config, req.body?.woo_status || 'any');

    let imported = 0;
    let updated = 0;
    const errors = [];

    for (const wooProduct of wooProducts) {
      try {
        const result = await upsertWooProduct(db, wooProduct, req.user?.id || null, {
          local_status: 'published'
        });

        if (result.updated) updated += 1;
        else imported += 1;
      } catch (error) {
        errors.push({
          woo_id: wooProduct.id,
          name: wooProduct.name,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `${imported} productos importados, ${updated} actualizados${errors.length ? `, ${errors.length} con error` : ''}.`,
      imported,
      updated,
      errors
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

router.post('/import-new-products', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError
    });
  }

  try {
    const db = getDb();
    ensureSchema(db);

    const allWooProducts = await getAllWooProducts(config, req.body?.woo_status || 'any');
    const localProducts = getLocalProducts(db);
    const missingProducts = allWooProducts.filter((p) => !findLocalMatch(p, localProducts).product);

    let imported = 0;
    const errors = [];

    for (const wooProduct of missingProducts) {
      try {
        await upsertWooProduct(db, wooProduct, req.user?.id || null, {
          local_status: 'published'
        });

        imported += 1;
      } catch (error) {
        errors.push({
          woo_id: wooProduct.id,
          name: wooProduct.name,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `${imported} productos nuevos importados desde WooCommerce.`,
      imported,
      errors
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

router.post('/publish-selected', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError
    });
  }

  try {
    const db = getDb();
    ensureSchema(db);

    const ids = Array.isArray(req.body?.product_ids) ? req.body.product_ids.map(Number).filter(Boolean) : [];

    if (ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Selecciona al menos un producto del sistema.'
      });
    }

    const placeholders = ids.map(() => '?').join(',');

    const products = db.prepare(`
      SELECT
        p.*,
        c.wp_id AS category_wp_id
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id IN (${placeholders})
    `).all(...ids);

    let published = 0;
    const errors = [];

    for (const product of products) {
      try {
        const woo = await publishLocalProductToWoo(config, db, product);

        db.prepare('UPDATE products SET wp_product_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(woo.id, 'published', product.id);

        published += 1;
      } catch (error) {
        errors.push({
          product_id: product.id,
          name: product.name,
          error: error.response?.data?.message || error.message
        });
      }
    }

    res.json({
      success: true,
      message: `${published} productos publicados en WooCommerce${errors.length ? `, ${errors.length} con error` : ''}.`,
      published,
      errors
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

router.post('/publish/:id', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const config = getWooConfig();
  const validationError = validateWooConfig(config);

  if (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError
    });
  }

  try {
    const db = getDb();
    ensureSchema(db);

    const product = db.prepare(`
      SELECT
        p.*,
        c.wp_id AS category_wp_id
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Producto no encontrado.'
      });
    }

    const woo = await publishLocalProductToWoo(config, db, product);

    db.prepare('UPDATE products SET wp_product_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(woo.id, 'published', product.id);

    res.json({
      success: true,
      message: 'Producto publicado correctamente en WooCommerce.',
      wp_product_id: woo.id,
      wp_url: woo.permalink
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: cleanWooError(err),
      details: err.response?.data || null
    });
  }
});

module.exports = router;
