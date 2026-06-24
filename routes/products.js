const express = require('express');
const path = require('path');
const fs = require('fs');
let sharp; try { sharp = require('sharp'); } catch (e) { sharp = null; }
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { uploadImages, uploadPdf, uploadDatasheet } = require('../middleware/upload');

const router = express.Router();

// GET /api/products - listar con filtros
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { status, search, category_id, brand_id, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let where = [];
  let params = [];

  // Vendedor solo ve sus propios productos
  if (req.user.role === 'vendedor') {
    where.push('p.created_by = ?');
    params.push(req.user.id);
  }

  if (status) { where.push('p.status = ?'); params.push(status); }
  if (category_id) { where.push('p.category_id = ?'); params.push(category_id); }
  if (brand_id) { where.push('p.brand_id = ?'); params.push(brand_id); }
  if (search) { where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.model LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as c FROM products p ${whereClause}`).get(...params);
  const products = db.prepare(`
    SELECT p.*,
      b.name as brand_name,
      c.name as category_name,
      u.name as created_by_name,
      (SELECT filename FROM product_images WHERE product_id = p.id AND is_main = 1 LIMIT 1) as main_image
    FROM products p
    LEFT JOIN brands b ON p.brand_id = b.id
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN users u ON p.created_by = u.id
    ${whereClause}
    ORDER BY p.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), parseInt(offset));

  res.json({ products, total: total.c, page: parseInt(page), pages: Math.ceil(total.c / limit) });
});

// GET /api/products/stats
router.get('/stats', authMiddleware, (req, res) => {
  const db = getDb();
  const stats = {
    total: db.prepare('SELECT COUNT(*) as c FROM products').get().c,
    draft: db.prepare("SELECT COUNT(*) as c FROM products WHERE status = 'draft'").get().c,
    pending: db.prepare("SELECT COUNT(*) as c FROM products WHERE status = 'pending'").get().c,
    approved: db.prepare("SELECT COUNT(*) as c FROM products WHERE status = 'approved'").get().c,
    published: db.prepare("SELECT COUNT(*) as c FROM products WHERE status = 'published'").get().c,
    outOfStock: db.prepare("SELECT COUNT(*) as c FROM products WHERE stock_status = 'outofstock'").get().c,
  };
  res.json(stats);
});

// GET /api/products/:id
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const product = db.prepare(`
    SELECT p.*, b.name as brand_name, c.name as category_name
    FROM products p
    LEFT JOIN brands b ON p.brand_id = b.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

  product.images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order').all(req.params.id);
  product.attributes = db.prepare('SELECT * FROM product_attributes WHERE product_id = ?').all(req.params.id);

  res.json(product);
});

// POST /api/products - crear producto
router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const {
    name, short_description, description, brand_id, category_id,
    model, type, sku, price, sale_price, stock_quantity, stock_status,
    youtube_url, seo_keyword, seo_title, seo_description, attributes
  } = req.body;

  if (!name) return res.status(400).json({ error: 'El nombre del producto es requerido' });

  const result = db.prepare(`
    INSERT INTO products (
      name, short_description, description, brand_id, category_id,
      model, type, sku, price, sale_price, stock_quantity, stock_status,
      youtube_url, seo_keyword, seo_title, seo_description, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
  `).run(
    name, short_description || '', description || '', brand_id || null, category_id || null,
    model || '', type || 'simple', sku || '', price || 0, sale_price || null,
    stock_quantity || 0, stock_status || 'instock',
    youtube_url || '', seo_keyword || '', seo_title || '', seo_description || '',
    req.user.id
  );

  const productId = result.lastInsertRowid;

  // Guardar atributos
  if (attributes && Array.isArray(attributes)) {
    const stmt = db.prepare('INSERT INTO product_attributes (product_id, name, value) VALUES (?, ?, ?)');
    attributes.forEach(a => { if (a.name && a.value) stmt.run(productId, a.name, a.value); });
  }

  db.prepare('INSERT INTO activity_log (user_id, action, entity, entity_id) VALUES (?, ?, ?, ?)').run(req.user.id, 'create', 'product', productId);

  res.status(201).json({ id: productId, message: 'Producto creado' });
});

// PUT /api/products/:id - actualizar
router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

  // Vendedor solo edita sus propios productos en borrador/rechazado
  if (req.user.role === 'vendedor' && product.created_by !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso para editar este producto' });
  }

  const {
    name, short_description, description, brand_id, category_id,
    model, type, sku, price, sale_price, stock_quantity, stock_status,
    youtube_url, seo_keyword, seo_title, seo_description, attributes
  } = req.body;

  db.prepare(`
    UPDATE products SET
      name = ?, short_description = ?, description = ?, brand_id = ?, category_id = ?,
      model = ?, type = ?, sku = ?, price = ?, sale_price = ?, stock_quantity = ?, stock_status = ?,
      youtube_url = ?, seo_keyword = ?, seo_title = ?, seo_description = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name || product.name, short_description ?? product.short_description,
    description ?? product.description, brand_id || product.brand_id, category_id || product.category_id,
    model ?? product.model, type ?? product.type, sku ?? product.sku,
    price ?? product.price, sale_price ?? product.sale_price,
    stock_quantity ?? product.stock_quantity, stock_status ?? product.stock_status,
    youtube_url ?? product.youtube_url, seo_keyword ?? product.seo_keyword,
    seo_title ?? product.seo_title, seo_description ?? product.seo_description,
    req.params.id
  );

  // Actualizar atributos
  if (attributes && Array.isArray(attributes)) {
    db.prepare('DELETE FROM product_attributes WHERE product_id = ?').run(req.params.id);
    const stmt = db.prepare('INSERT INTO product_attributes (product_id, name, value) VALUES (?, ?, ?)');
    attributes.forEach(a => { if (a.name && a.value) stmt.run(req.params.id, a.name, a.value); });
  }

  res.json({ message: 'Producto actualizado' });
});

// POST /api/products/:id/status - cambiar status (aprobar, rechazar, enviar a revisión, publicar)
router.post('/:id/status', authMiddleware, (req, res) => {
  const { status } = req.body;
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

  const validTransitions = {
    vendedor: { draft: ['pending'] },
    admin: { draft: ['pending', 'approved'], pending: ['approved', 'draft'], approved: ['published', 'draft'] },
    superadmin: { draft: ['pending', 'approved', 'published'], pending: ['approved', 'draft', 'published'], approved: ['published', 'draft'], published: ['draft'] }
  };

  const allowed = validTransitions[req.user.role]?.[product.status] || [];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `No puedes cambiar el estado a "${status}"` });
  }

  db.prepare('UPDATE products SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  db.prepare('INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(req.user.id, `status_${status}`, 'product', req.params.id, `${product.status} → ${status}`);

  res.json({ message: 'Estado actualizado', status });
});

// POST /api/products/:id/images - subir imágenes
router.post('/:id/images', authMiddleware, uploadImages.array('images', 10), async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No se recibieron imágenes' });

  const isMain = req.body.is_main === 'true';
  const hasMain = db.prepare('SELECT id FROM product_images WHERE product_id = ? AND is_main = 1').get(req.params.id);
  const imagesDir = path.join(__dirname, '..', 'uploads', 'images');

  const saved = [];
  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const outName = `opt_${file.filename}`;
    const outPath = path.join(imagesDir, outName);

    // Redimensionar a 800x800 con Sharp (si está disponible)
    try {
      if (sharp) {
        await sharp(file.path)
          .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toFile(outPath);
        fs.unlinkSync(file.path);
      } else {
        fs.renameSync(file.path, outPath);
      }
    } catch (e) {
      // Si falla sharp, usar el archivo original sin redimensionar
      fs.renameSync(file.path, outPath);
    }

    const makeMain = (isMain && i === 0 && !hasMain) ? 1 : 0;
    if (makeMain) {
      db.prepare('UPDATE product_images SET is_main = 0 WHERE product_id = ?').run(req.params.id);
    }

    const existingCount = db.prepare('SELECT COUNT(*) as c FROM product_images WHERE product_id = ?').get(req.params.id);
    const result = db.prepare('INSERT INTO product_images (product_id, filename, is_main, sort_order) VALUES (?, ?, ?, ?)').run(req.params.id, outName, makeMain, existingCount.c + i);
    saved.push({ id: result.lastInsertRowid, filename: outName, is_main: makeMain });
  }

  res.status(201).json(saved);
});

// DELETE /api/products/:id/images/:imageId
router.delete('/:id/images/:imageId', authMiddleware, (req, res) => {
  const db = getDb();
  const image = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(req.params.imageId, req.params.id);
  if (!image) return res.status(404).json({ error: 'Imagen no encontrada' });

  try {
    const imgPath = path.join(__dirname, '..', 'uploads', 'images', image.filename);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  } catch (e) {}

  db.prepare('DELETE FROM product_images WHERE id = ?').run(req.params.imageId);
  res.json({ message: 'Imagen eliminada' });
});

// POST /api/products/:id/pdf - subir PDF ficha técnica
router.post('/:id/pdf', authMiddleware, uploadPdf.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió PDF' });
  const db = getDb();
  db.prepare('UPDATE products SET pdf_filename = ? WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ filename: req.file.filename });
});

// POST /api/products/:id/set-main-image
router.post('/:id/set-main-image', authMiddleware, (req, res) => {
  const { image_id } = req.body;
  const db = getDb();
  db.prepare('UPDATE product_images SET is_main = 0 WHERE product_id = ?').run(req.params.id);
  db.prepare('UPDATE product_images SET is_main = 1 WHERE id = ? AND product_id = ?').run(image_id, req.params.id);
  res.json({ message: 'Imagen principal actualizada' });
});

// DELETE /api/products/:id
router.delete('/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const db = getDb();
  // Eliminar imágenes físicas
  const images = db.prepare('SELECT filename FROM product_images WHERE product_id = ?').all(req.params.id);
  images.forEach(img => {
    try {
      fs.unlinkSync(path.join(__dirname, '..', 'uploads', 'images', img.filename));
    } catch (e) {