const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

function getWooConfig(db) {
  const url = db.prepare("SELECT value FROM settings WHERE key = 'wc_url'").get()?.value;
  const key = db.prepare("SELECT value FROM settings WHERE key = 'wc_key'").get()?.value || process.env.WC_KEY;
  const secret = db.prepare("SELECT value FROM settings WHERE key = 'wc_secret'").get()?.value || process.env.WC_SECRET;
  return { url: url || process.env.WC_URL, key, secret };
}

function wooClient(config) {
  return axios.create({
    baseURL: `${config.url}/wp-json/wc/v3`,
    auth: { username: config.key, password: config.secret },
    timeout: 30000
  });
}

// POST /api/wordpress/test - probar conexión
router.post('/test', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const db = getDb();
  const config = getWooConfig(db);
  if (!config.url || !config.key || !config.secret) {
    return res.status(400).json({ error: 'Configura la URL, Key y Secret de WooCommerce primero' });
  }

  try {
    const woo = wooClient(config);
    const response = await woo.get('/products?per_page=1');
    res.json({ success: true, message: `Conexión exitosa. ${response.headers['x-wp-total'] || '?'} productos en WooCommerce.` });
  } catch (err) {
    res.status(400).json({ error: 'Error de conexión: ' + (err.response?.data?.message || err.message) });
  }
});

// POST /api/wordpress/sync-categories - importar categorías desde WooCommerce
router.post('/sync-categories', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const db = getDb();
  const config = getWooConfig(db);
  try {
    const woo = wooClient(config);
    const response = await woo.get('/products/categories?per_page=100');
    const categories = response.data;

    const stmt = db.prepare('INSERT OR IGNORE INTO categories (name, slug, wp_id) VALUES (?, ?, ?)');
    let added = 0;
    categories.forEach(cat => {
      try { stmt.run(cat.name, cat.slug, cat.id); added++; } catch(e) {}
    });

    res.json({ message: `${added} categorías importadas desde WooCommerce`, total: categories.length });
  } catch (err) {
    res.status(400).json({ error: 'Error: ' + (err.response?.data?.message || err.message) });
  }
});

// POST /api/wordpress/publish/:id - publicar producto en WooCommerce
router.post('/publish/:id', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const db = getDb();
  const product = db.prepare(`
    SELECT p.*, b.name as brand_name, c.name as category_name, c.wp_id as category_wp_id
    FROM products p
    LEFT JOIN brands b ON p.brand_id = b.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
  if (!['approved', 'published'].includes(product.status)) {
    return res.status(400).json({ error: 'El producto debe estar aprobado para publicar' });
  }

  const config = getWooConfig(db);
  const woo = wooClient(config);
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY is_main DESC, sort_order').all(req.params.id);
  const attributes = db.prepare('SELECT * FROM product_attributes WHERE product_id = ?').all(req.params.id);

  try {
    // Subir imágenes a WordPress primero
    const wpImages = [];
    for (const img of images) {
      try {
        const imgPath = path.join(__dirname, '..', 'uploads', 'images', img.filename);
        if (!fs.existsSync(imgPath)) continue;

        const form = new FormData();
        form.append('file', fs.createReadStream(imgPath), img.filename);

        const wpResponse = await axios.post(`${config.url}/wp-json/wp/v2/media`, form, {
          headers: { ...form.getHeaders() },
          auth: { username: config.key, password: config.secret }
        });
        wpImages.push({ id: wpResponse.data.id, src: wpResponse.data.source_url });
      } catch (e) {
        console.error('Error subiendo imagen:', e.message);
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
      attributes: attributes.map(a => ({ name: a.name, options: [a.value], visible: true })),
      categories: product.category_wp_id ? [{ id: product.category_wp_id }] : [],
      meta_data: [
        { key: '_yoast_wpseo_focuskw', value: product.seo_keyword || '' },
        { key: '_yoast_wpseo_title', value: product.seo_title || '' },
        { key: '_yoast_wpseo_metadesc', value: product.seo_description || '' },
      ]
    };

    let response;
    if (product.wp_product_id) {
      // Actualizar producto existente
      response = await woo.put(`/products/${product.wp_product_id}`, productData);
    } else {
      // Crear nuevo producto
      response = await woo.post('/products', productData);
    }

    const wpId = response.data.id;
    db.prepare('UPDATE products SET wp_product_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(wpId, 'published', req.params.id);
    db.prepare('INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'publish', 'product', req.params.id, `WP ID: ${wpId}`);

    res.json({ success: true, wp_product_id: wpId, wp_url: response.data.permalink });
  } catch (err) {
    console.error('WooCommerce error:', err.response?.data || err.message);
    res.status(400).json({ error: 'Error publicando en WooCommerce: ' + (err.response?.data?.message || err.message) });
  }
});

// POST /api/wordpress/publish-bulk - publicar varios productos
router.post('/publish-bulk', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const { product_ids } = req.body;
  if (!product_ids || !Array.isArray(product_ids)) return res.status(400).json({ error: 'Lista de IDs requerida' });

  const results = [];
  for (const id of product_ids) {
    try {
      // Reutilizar lógica de publicación individual
      const result = await publishProduct(id, req, getDb(), getWooConfig(getDb()));
      results.push({ id, success: true, wp_id: result.wp_id });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }

  res.json({ results });
});


// POST /api/wordpress/sync-brands - importar marcas desde atributos de WooCommerce
router.post('/sync-brands', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const db = getDb();
  const config = getWooConfig(db);
  if (!config.url || !config.key || !config.secret) {
    return res.status(400).json({ error: 'Configura WooCommerce primero' });
  }
  try {
    const woo = wooClient(config);
    let brands = [];

    // Intentar obtener marcas desde el atributo pa_marca o pa_brand
    try {
      const attrsRes = await woo.get('/products/attributes?per_page=100');
      const brandAttr = attrsRes.data.find(a =>
        ['marca', 'brand', 'fabricante', 'manufacturer'].includes(a.slug.toLowerCase()) ||
        a.name.toLowerCase().includes('marca') || a.name.toLowerCase().includes('brand')
      );
      if (brandAttr) {
        const termsRes = await woo.get(`/products/attributes/${brandAttr.id}/terms?per_page=100`);
        brands = termsRes.data.map(t => ({ name: t.name, slug: t.slug }));
      }
    } catch (e) {}

    // Si no hay atributo de marca, extraer de productos directamente
    if (brands.length === 0) {
      const prodsRes = await woo.get('/products?per_page=100&status=any');
      const brandSet = new Set();
      prodsRes.data.forEach(p => {
        p.attributes?.forEach(a => {
          if (a.name.toLowerCase().includes('marca') || a.name.toLowerCase().includes('brand')) {
            a.options?.forEach(o => brandSet.add(o));
          }
        });
        // También revisar tags como marcas
        p.tags?.forEach(t => brandSet.add(t.name));
      });
      brands = [...brandSet].map(name => ({ name, slug: name.toLowerCase().replace(/\s+/g, '-') }));
    }

    const stmt = db.prepare('INSERT OR IGNORE INTO brands (name, slug) VALUES (?, ?)');
    let added = 0;
    brands.forEach(b => {
      try { stmt.run(b.name, b.slug); added++; } catch(e) {}
    });

    res.json({ message: `${added} marca(s) importada(s) desde WooCommerce`, total: brands.length });
  } catch (err) {
    res.status(400).json({ error: 'Error: ' + (err.response?.data?.message || err.message) });
  }
});

// POST /api/wordpress/sync-attributes - importar atributos/especificaciones desde WooCommerce
router.post('/sync-attributes', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  const db = getDb();
  const config = getWooConfig(db);
  if (!config.url || !config.key || !config.secret) {
    return res.status(400).json({ error: 'Configura WooCommerce primero' });
  }
  try {
    const woo = wooClient(config);
    const attrsRes = await woo.get('/products/attributes?per_page=100');
    const attrs = attrsRes.data;

    const stmt = db.prepare('INSERT OR IGNORE INTO attribute_templates (name, unit) VALUES (?, ?)');
    let added = 0;
    attrs.forEach(a => {
      // Detectar unidad del nombre del atributo (ej. "Potencia (W)" → unit="W")
      const unitMatch = a.name.match(/\(([^)]+)\)$/);
      const unit = unitMatch ? unitMatch[1] : '';
      const cleanName = a.name.replace(/\s*\([^)]+\)$/, '').trim();
      try { stmt.run(cleanName, unit); added++; } catch(e) {}
    });

    // También extraer atributos únicos de los productos
    const prodsRes = await woo.get('/products?per_page=50&status=any');
    const attrNames = new Set();
    prodsRes.data.forEach(p => {
      p.attributes?.forEach(a => attrNames.add(a.name));
    });
    attrNames.forEach(name => {
      try { stmt.run(name, ''); added++; } catch(e) {}
    });

    res.json({ message: `${added} atributo(s) importado(s) desde WooCommerce`, total: attrs.length });
  } catch (err) {
    res.status(400).json({ error: 'Error: ' + (err.response?.data?.message || err.message) });
  }
});

module.exports = router;
