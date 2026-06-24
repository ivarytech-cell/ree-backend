const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');
const router = express.Router();

function getWooConfig() {
  const db = getDb();
  const url = db.prepare("SELECT value FROM settings WHERE key='wc_url'").get()?.value || process.env.WC_URL;
  const key = db.prepare("SELECT value FROM settings WHERE key='wc_key'").get()?.value || process.env.WC_KEY;
  const secret = db.prepare("SELECT value FROM settings WHERE key='wc_secret'").get()?.value || process.env.WC_SECRET;
  return { url, key, secret };
}

function wooClient(config) {
  return axios.create({
    baseURL: `${config.url}/wp-json/wc/v3`,
    auth: { username: config.key, password: config.secret },
    timeout: 30000
  });
}

router.post('/test', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const config = getWooConfig();
  if (!config.url || !config.key || !config.secret) return res.status(400).json({ error: 'Configura WooCommerce primero' });
  try {
    const r = await wooClient(config).get('/products?per_page=1');
    res.json({ success: true, message: `Conexión exitosa. ${r.headers['x-wp-total'] || '?'} productos.` });
  } catch (err) {
    res.status(400).json({ error: 'Error: ' + (err.response?.data?.message || err.message) });
  }
});

router.post('/sync-categories', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const config = getWooConfig();
  try {
    const db = getDb();
    const { data } = await wooClient(config).get('/products/categories?per_page=100');
    const stmt = db.prepare('INSERT OR IGNORE INTO categories (name, slug, wp_id) VALUES (?, ?, ?)');
    let added = 0;
    data.forEach(cat => { try { stmt.run(cat.name, cat.slug, cat.id); added++; } catch(e) {} });
    res.json({ message: `${added} categorías importadas`, total: data.length });
  } catch (err) {
    res.status(400).json({ error: 'Error: ' + (err.response?.data?.message || err.message) });
  }
});

router.post('/sync-brands', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const config = getWooConfig();
  try {
    const db = getDb();
    const attrsRes = await wooClient(config).get('/products/attributes?per_page=100');
    const brandAttr = attrsRes.data.find(a => ['marca','brand','fabricante'].includes(a.slug.toLowerCase()) || a.name.toLowerCase().includes('marca'));
    let brands = [];
    if (brandAttr) {
      const termsRes = await wooClient(config).get(`/products/attributes/${brandAttr.id}/terms?per_page=100`);
      brands = termsRes.data.map(t => ({ name: t.name, slug: t.slug }));
    }
    const stmt = db.prepare('INSERT OR IGNORE INTO brands (name, slug) VALUES (?, ?)');
    let added = 0;
    brands.forEach(b => { try { stmt.run(b.name, b.slug); added++; } catch(e) {} });
    res.json({ message: `${added} marcas importadas`, total: brands.length });
  } catch (err) {
    res.status(400).json({ error: 'Error: ' + (err.response?.data?.message || err.message) });
  }
});

router.post('/sync-attributes', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const config = getWooConfig();
  try {
    const db = getDb();
    const { data } = await wooClient(config).get('/products/attributes?per_page=100');
    const stmt = db.prepare('INSERT OR IGNORE INTO attribute_templates (name, unit) VALUES (?, ?)');
    let added = 0;
    data.forEach(a => {
      const unitMatch = a.name.match(/\(([^)]+)\)$/);
      const unit = unitMatch ? unitMatch[1] : '';
      const cleanName = a.name.replace(/\s*\([^)]+\)$/, '').trim();
      try { stmt.run(cleanName, unit); added++; } catch(e) {}
    });
    res.json({ message: `${added} atributos importados`, total: data.length });
  } catch (err) {
    res.status(400).json({ error: 'Error: ' + (err.response?.data?.message || err.message) });
  }
});

router.post('/publish/:id', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT p.*, c.wp_id as category_wp_id FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
  const config = getWooConfig();
  const woo = wooClient(config);
  const images = db.prepare('SELECT * FROM product_images WHERE product_id=? ORDER BY is_main DESC, sort_order').all(req.params.id);
  const attributes = db.prepare('SELECT * FROM product_attributes WHERE product_id=?').all(req.params.id);

  try {
    const wpImages = [];
    for (const img of images) {
      try {
        const imgPath = path.join(__dirname, '..', 'uploads', 'images', img.filename);
        if (!fs.existsSync(imgPath)) continue;
        const form = new FormData();
        form.append('file', fs.createReadStream(imgPath), img.filename);
        const wpRes = await axios.post(`${config.url}/wp-json/wp/v2/media`, form, { headers: form.getHeaders(), auth: { username: config.key, password: config.secret } });
        wpImages.push({ id: wpRes.data.id, src: wpRes.data.source_url });
      } catch(e) {}
    }

    const productData = {
      name: product.name, type: product.type || 'simple', status: 'publish',
      description: product.description || '', short_description: product.short_description || '',
      sku: product.sku || '', regular_price: String(product.price || 0),
      sale_price: product.sale_price ? String(product.sale_price) : '',
      manage_stock: true, stock_quantity: product.stock_quantity || 0,
      stock_status: product.stock_status || 'instock', images: wpImages,
      attributes: attributes.map(a => ({ name: a.name, options: [a.value], visible: true })),
      categories: product.category_wp_id ? [{ id: product.category_wp_id }] : [],
    };

    let response;
    if (product.wp_product_id) {
      response = await woo.put(`/products/${product.wp_product_id}`, productData);
    } else {
      response = await woo.post('/products', productData);
    }

    db.prepare('UPDATE products SET wp_product_id=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(response.data.id, 'published', req.params.id);
    res.json({ success: true, wp_product_id: response.data.id, wp_url: response.data.permalink });
  } catch (err) {
    res.status(400).json({ error: 'Error WooCommerce: ' + (err.response?.data?.message || err.message) });
  }
});

module.exports = router;
