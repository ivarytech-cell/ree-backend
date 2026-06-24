const express = require('express');
const path = require('path');
const fs = require('fs');

let sharp;
try {
  sharp = require('sharp');
} catch (error) {
  sharp = null;
}

const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { uploadImages, uploadPdf } = require('../middleware/upload');

const router = express.Router();

const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.BACKEND_URL || 'https://ree-backend-production.up.railway.app');

function getColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name);
  } catch (error) {
    return [];
  }
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = getColumns(db, table);

  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureProductsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT,
      parent_id INTEGER,
      wp_id INTEGER,
      woo_id INTEGER,
      created_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT,
      logo TEXT,
      created_at DATETIME
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
      woo_id INTEGER,
      created_by INTEGER,
      created_at DATETIME,
      updated_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      is_main INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS product_attributes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      entity TEXT,
      entity_id INTEGER,
      details TEXT,
      created_at DATETIME
    );
  `);

  addColumnIfMissing(db, 'products', 'short_description', 'TEXT');
  addColumnIfMissing(db, 'products', 'description', 'TEXT');
  addColumnIfMissing(db, 'products', 'brand_id', 'INTEGER');
  addColumnIfMissing(db, 'products', 'category_id', 'INTEGER');
  addColumnIfMissing(db, 'products', 'model', 'TEXT');
  addColumnIfMissing(db, 'products', 'type', "TEXT DEFAULT 'simple'");
  addColumnIfMissing(db, 'products', 'sku', 'TEXT');
  addColumnIfMissing(db, 'products', 'price', 'REAL');
  addColumnIfMissing(db, 'products', 'sale_price', 'REAL');
  addColumnIfMissing(db, 'products', 'stock_quantity', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'products', 'stock_status', "TEXT DEFAULT 'instock'");
  addColumnIfMissing(db, 'products', 'youtube_url', 'TEXT');
  addColumnIfMissing(db, 'products', 'pdf_filename', 'TEXT');
  addColumnIfMissing(db, 'products', 'seo_keyword', 'TEXT');
  addColumnIfMissing(db, 'products', 'seo_title', 'TEXT');
  addColumnIfMissing(db, 'products', 'seo_description', 'TEXT');
  addColumnIfMissing(db, 'products', 'status', "TEXT DEFAULT 'draft'");
  addColumnIfMissing(db, 'products', 'wp_product_id', 'INTEGER');
  addColumnIfMissing(db, 'products', 'woo_id', 'INTEGER');
  addColumnIfMissing(db, 'products', 'created_by', 'INTEGER');
  addColumnIfMissing(db, 'products', 'created_at', 'DATETIME');
  addColumnIfMissing(db, 'products', 'updated_at', 'DATETIME');

  addColumnIfMissing(db, 'categories', 'slug', 'TEXT');
  addColumnIfMissing(db, 'categories', 'parent_id', 'INTEGER');
  addColumnIfMissing(db, 'categories', 'wp_id', 'INTEGER');
  addColumnIfMissing(db, 'categories', 'woo_id', 'INTEGER');

  addColumnIfMissing(db, 'brands', 'slug', 'TEXT');
  addColumnIfMissing(db, 'brands', 'logo', 'TEXT');
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function cleanBody(body = {}) {
  return {
    name: body.name || '',
    short_description: body.short_description || '',
    description: body.description || '',
    brand_id: nullableNumber(body.brand_id),
    category_id: nullableNumber(body.category_id),
    model: body.model || '',
    type: body.type || 'simple',
    sku: body.sku || '',
    price: safeNumber(body.price, 0),
    sale_price: nullableNumber(body.sale_price),
    stock_quantity: safeNumber(body.stock_quantity, 0),
    stock_status: body.stock_status || 'instock',
    youtube_url: body.youtube_url || '',
    seo_keyword: body.seo_keyword || '',
    seo_title: body.seo_title || '',
    seo_description: body.seo_description || '',
    attributes: Array.isArray(body.attributes) ? body.attributes : []
  };
}

function productImageUrl(filename) {
  return filename ? `${BACKEND_URL}/uploads/images/${filename}` : null;
}

function logActivity(db, userId, action, entity, entityId, details = '') {
  try {
    db.prepare(`
      INSERT INTO activity_log (
        user_id,
        action,
        entity,
        entity_id,
        details,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(userId || null, action, entity, entityId, details);
  } catch (error) {}
}

function getProductWithRelations(db, id) {
  const product = db.prepare(`
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
    WHERE p.id = ?
  `).get(id);

  if (!product) return null;

  product.main_image_url = productImageUrl(product.main_image);

  product.images = db.prepare(`
    SELECT
      *,
      filename AS url_filename
    FROM product_images
    WHERE product_id = ?
    ORDER BY is_main DESC, sort_order ASC, id ASC
  `).all(id).map((image) => ({
    ...image,
    url: productImageUrl(image.filename)
  }));

  product.attributes = db.prepare(`
    SELECT *
    FROM product_attributes
    WHERE product_id = ?
    ORDER BY id ASC
  `).all(id);

  return product;
}

// GET /api/products
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const {
      status,
      search,
      category_id,
      brand_id,
      page = 1,
      limit = 20
    } = req.query;

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (safePage - 1) * safeLimit;

    const where = [];
    const params = [];

    if (req.user && req.user.role === 'vendedor') {
      where.push('p.created_by = ?');
      params.push(req.user.id);
    }

    if (status) {
      where.push('p.status = ?');
      params.push(status);
    }

    if (category_id) {
      where.push('p.category_id = ?');
      params.push(category_id);
    }

    if (brand_id) {
      where.push('p.brand_id = ?');
      params.push(brand_id);
    }

    if (search) {
      where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.model LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = db.prepare(`
      SELECT COUNT(*) AS c
      FROM products p
      ${whereClause}
    `).get(...params);

    const products = db.prepare(`
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
      ${whereClause}
      ORDER BY
        CASE WHEN p.updated_at IS NULL THEN 1 ELSE 0 END,
        p.updated_at DESC,
        p.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, safeLimit, offset).map((product) => ({
      ...product,
      main_image_url: productImageUrl(product.main_image),
      image: productImageUrl(product.main_image)
    }));

    res.json({
      products,
      total: total?.c || 0,
      page: safePage,
      pages: Math.ceil((total?.c || 0) / safeLimit),
      limit: safeLimit
    });
  } catch (error) {
    console.error('[products] GET error:', error);
    res.status(500).json({
      error: 'Error cargando productos: ' + error.message
    });
  }
});

// GET /api/products/stats
router.get('/stats', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const stat = (sql) => {
      try {
        return db.prepare(sql).get().c || 0;
      } catch (error) {
        return 0;
      }
    };

    res.json({
      total: stat('SELECT COUNT(*) AS c FROM products'),
      draft: stat("SELECT COUNT(*) AS c FROM products WHERE status = 'draft'"),
      pending: stat("SELECT COUNT(*) AS c FROM products WHERE status = 'pending'"),
      approved: stat("SELECT COUNT(*) AS c FROM products WHERE status = 'approved'"),
      published: stat("SELECT COUNT(*) AS c FROM products WHERE status = 'published'"),
      outOfStock: stat("SELECT COUNT(*) AS c FROM products WHERE stock_status = 'outofstock'")
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando estadísticas: ' + error.message
    });
  }
});

// GET /api/products/:id
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const product = getProductWithRelations(db, req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Producto no encontrado'
      });
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando producto: ' + error.message
    });
  }
});

// POST /api/products
router.post('/', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const data = cleanBody(req.body || {});

    if (!data.name) {
      return res.status(400).json({
        error: 'El nombre del producto es requerido'
      });
    }

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
        created_by,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      data.name,
      data.short_description,
      data.description,
      data.brand_id,
      data.category_id,
      data.model,
      data.type,
      data.sku,
      data.price,
      data.sale_price,
      data.stock_quantity,
      data.stock_status,
      data.youtube_url,
      data.seo_keyword,
      data.seo_title,
      data.seo_description,
      req.user?.id || null
    );

    const productId = result.lastInsertRowid;

    if (data.attributes.length) {
      const stmt = db.prepare(`
        INSERT INTO product_attributes (
          product_id,
          name,
          value
        )
        VALUES (?, ?, ?)
      `);

      data.attributes.forEach((attr) => {
        if (attr.name && attr.value) {
          stmt.run(productId, attr.name, attr.value);
        }
      });
    }

    logActivity(db, req.user?.id, 'create', 'product', productId);

    res.status(201).json({
      id: productId,
      message: 'Producto creado correctamente',
      product: getProductWithRelations(db, productId)
    });
  } catch (error) {
    console.error('[products] POST error:', error);
    res.status(500).json({
      error: 'Error creando producto: ' + error.message
    });
  }
});

// PUT /api/products/:id
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Producto no encontrado'
      });
    }

    if (req.user?.role === 'vendedor' && product.created_by !== req.user.id) {
      return res.status(403).json({
        error: 'No tienes permiso para editar este producto'
      });
    }

    const data = cleanBody({
      ...product,
      ...(req.body || {})
    });

    db.prepare(`
      UPDATE products
      SET
        name = ?,
        short_description = ?,
        description = ?,
        brand_id = ?,
        category_id = ?,
        model = ?,
        type = ?,
        sku = ?,
        price = ?,
        sale_price = ?,
        stock_quantity = ?,
        stock_status = ?,
        youtube_url = ?,
        seo_keyword = ?,
        seo_title = ?,
        seo_description = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      data.name || product.name,
      data.short_description,
      data.description,
      data.brand_id,
      data.category_id,
      data.model,
      data.type,
      data.sku,
      data.price,
      data.sale_price,
      data.stock_quantity,
      data.stock_status,
      data.youtube_url,
      data.seo_keyword,
      data.seo_title,
      data.seo_description,
      req.params.id
    );

    if (Array.isArray(req.body?.attributes)) {
      db.prepare('DELETE FROM product_attributes WHERE product_id = ?').run(req.params.id);

      const stmt = db.prepare(`
        INSERT INTO product_attributes (
          product_id,
          name,
          value
        )
        VALUES (?, ?, ?)
      `);

      req.body.attributes.forEach((attr) => {
        if (attr.name && attr.value) {
          stmt.run(req.params.id, attr.name, attr.value);
        }
      });
    }

    logActivity(db, req.user?.id, 'update', 'product', req.params.id);

    res.json({
      message: 'Producto actualizado correctamente',
      product: getProductWithRelations(db, req.params.id)
    });
  } catch (error) {
    console.error('[products] PUT error:', error);
    res.status(500).json({
      error: 'Error actualizando producto: ' + error.message
    });
  }
});

// POST /api/products/:id/status
router.post('/:id/status', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const { status } = req.body;
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Producto no encontrado'
      });
    }

    const validStatuses = ['draft', 'pending', 'approved', 'published', 'rejected'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Estado inválido: ${status}`
      });
    }

    db.prepare(`
      UPDATE products
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, req.params.id);

    logActivity(
      db,
      req.user?.id,
      `status_${status}`,
      'product',
      req.params.id,
      `${product.status || ''} → ${status}`
    );

    res.json({
      message: 'Estado actualizado correctamente',
      status
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error cambiando estado: ' + error.message
    });
  }
});

// POST /api/products/:id/images
router.post('/:id/images', authMiddleware, uploadImages.array('images', 10), async (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Producto no encontrado'
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'No se recibieron imágenes'
      });
    }

    const imagesDir = path.join(__dirname, '..', 'uploads', 'images');

    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, {
        recursive: true
      });
    }

    const existingMain = db.prepare(`
      SELECT id
      FROM product_images
      WHERE product_id = ? AND is_main = 1
      LIMIT 1
    `).get(req.params.id);

    const saved = [];

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const ext = path.extname(file.originalname || file.filename || '').toLowerCase() || '.jpg';
      const finalExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
      const outName = `product_${req.params.id}_${Date.now()}_${i}${finalExt}`;
      const outPath = path.join(imagesDir, outName);

      try {
        if (sharp) {
          await sharp(file.path)
            .resize(800, 800, {
              fit: 'inside',
              withoutEnlargement: true
            })
            .toFile(outPath);

          fs.unlinkSync(file.path);
        } else {
          fs.renameSync(file.path, outPath);
        }
      } catch (error) {
        try {
          fs.renameSync(file.path, outPath);
        } catch (renameError) {}
      }

      const makeMain = !existingMain && i === 0 ? 1 : 0;

      if (makeMain) {
        db.prepare('UPDATE product_images SET is_main = 0 WHERE product_id = ?').run(req.params.id);
      }

      const count = db.prepare(`
        SELECT COUNT(*) AS c
        FROM product_images
        WHERE product_id = ?
      `).get(req.params.id);

      const result = db.prepare(`
        INSERT INTO product_images (
          product_id,
          filename,
          is_main,
          sort_order,
          created_at
        )
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(req.params.id, outName, makeMain, (count?.c || 0) + i);

      saved.push({
        id: result.lastInsertRowid,
        filename: outName,
        is_main: makeMain,
        url: productImageUrl(outName)
      });
    }

    res.status(201).json(saved);
  } catch (error) {
    console.error('[products] image upload error:', error);
    res.status(500).json({
      error: 'Error subiendo imágenes: ' + error.message
    });
  }
});

// DELETE /api/products/:id/images/:imageId
router.delete('/:id/images/:imageId', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const image = db.prepare(`
      SELECT *
      FROM product_images
      WHERE id = ? AND product_id = ?
    `).get(req.params.imageId, req.params.id);

    if (!image) {
      return res.status(404).json({
        error: 'Imagen no encontrada'
      });
    }

    try {
      const imgPath = path.join(__dirname, '..', 'uploads', 'images', image.filename);

      if (fs.existsSync(imgPath)) {
        fs.unlinkSync(imgPath);
      }
    } catch (error) {}

    db.prepare('DELETE FROM product_images WHERE id = ?').run(req.params.imageId);

    res.json({
      message: 'Imagen eliminada correctamente'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error eliminando imagen: ' + error.message
    });
  }
});

// POST /api/products/:id/pdf
router.post('/:id/pdf', authMiddleware, uploadPdf.single('pdf'), (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Producto no encontrado'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'No se recibió PDF'
      });
    }

    db.prepare(`
      UPDATE products
      SET pdf_filename = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.file.filename, req.params.id);

    res.json({
      filename: req.file.filename,
      url: `${BACKEND_URL}/uploads/pdfs/${req.file.filename}`
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error subiendo PDF: ' + error.message
    });
  }
});

// POST /api/products/:id/set-main-image
router.post('/:id/set-main-image', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const { image_id } = req.body;

    if (!image_id) {
      return res.status(400).json({
        error: 'image_id requerido'
      });
    }

    db.prepare('UPDATE product_images SET is_main = 0 WHERE product_id = ?').run(req.params.id);
    db.prepare('UPDATE product_images SET is_main = 1 WHERE id = ? AND product_id = ?').run(image_id, req.params.id);

    res.json({
      message: 'Imagen principal actualizada correctamente'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error actualizando imagen principal: ' + error.message
    });
  }
});

// DELETE /api/products/:id
router.delete('/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Producto no encontrado'
      });
    }

    const images = db.prepare(`
      SELECT filename
      FROM product_images
      WHERE product_id = ?
    `).all(req.params.id);

    images.forEach((image) => {
      try {
        const imgPath = path.join(__dirname, '..', 'uploads', 'images', image.filename);

        if (fs.existsSync(imgPath)) {
          fs.unlinkSync(imgPath);
        }
      } catch (error) {}
    });

    db.prepare('DELETE FROM product_attributes WHERE product_id = ?').run(req.params.id);
    db.prepare('DELETE FROM product_images WHERE product_id = ?').run(req.params.id);
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);

    logActivity(db, req.user?.id, 'delete', 'product', req.params.id, product.name);

    res.json({
      message: 'Producto eliminado correctamente'
    });
  } catch (error) {
    console.error('[products] DELETE error:', error);
    res.status(500).json({
      error: 'Error eliminando producto: ' + error.message
    });
  }
});

module.exports = router;
