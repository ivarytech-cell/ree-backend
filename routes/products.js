const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

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

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'https://reelectrosistemas.com/app';

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
      slug TEXT,
      short_description TEXT,
      description TEXT,
      brand_id INTEGER,
      category_id INTEGER,
      model TEXT,
      type TEXT DEFAULT 'simple',
      sku TEXT,
      cost_price REAL DEFAULT 0,
      price REAL DEFAULT 0,
      regular_price REAL DEFAULT 0,
      sale_price REAL,
      sale_percent REAL DEFAULT 0,
      extra_discount_percent REAL DEFAULT 0,
      min_allowed_price REAL DEFAULT 0,
      sale_start_date TEXT,
      sale_end_date TEXT,
      stock_quantity INTEGER DEFAULT 0,
      stock_status TEXT DEFAULT 'instock',
      youtube_url TEXT,
      pdf_filename TEXT,
      seo_keyword TEXT,
      seo_title TEXT,
      seo_description TEXT,
      product_url TEXT,
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

  addColumnIfMissing(db, 'products', 'slug', 'TEXT');
  addColumnIfMissing(db, 'products', 'short_description', 'TEXT');
  addColumnIfMissing(db, 'products', 'description', 'TEXT');
  addColumnIfMissing(db, 'products', 'brand_id', 'INTEGER');
  addColumnIfMissing(db, 'products', 'category_id', 'INTEGER');
  addColumnIfMissing(db, 'products', 'model', 'TEXT');
  addColumnIfMissing(db, 'products', 'type', "TEXT DEFAULT 'simple'");
  addColumnIfMissing(db, 'products', 'sku', 'TEXT');

  addColumnIfMissing(db, 'products', 'cost_price', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'products', 'price', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'products', 'regular_price', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'products', 'sale_price', 'REAL');
  addColumnIfMissing(db, 'products', 'sale_percent', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'products', 'extra_discount_percent', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'products', 'min_allowed_price', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'products', 'sale_start_date', 'TEXT');
  addColumnIfMissing(db, 'products', 'sale_end_date', 'TEXT');

  addColumnIfMissing(db, 'products', 'stock_quantity', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'products', 'stock_status', "TEXT DEFAULT 'instock'");
  addColumnIfMissing(db, 'products', 'youtube_url', 'TEXT');
  addColumnIfMissing(db, 'products', 'pdf_filename', 'TEXT');
  addColumnIfMissing(db, 'products', 'seo_keyword', 'TEXT');
  addColumnIfMissing(db, 'products', 'seo_title', 'TEXT');
  addColumnIfMissing(db, 'products', 'seo_description', 'TEXT');
  addColumnIfMissing(db, 'products', 'product_url', 'TEXT');
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

function canSeeCost(user) {
  const role = String(user?.role || '').toLowerCase();

  return ['superadmin', 'admin', 'contabilidad', 'accounting'].includes(role);
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

function normalizeDate(value) {
  if (!value) return '';

  return String(value).trim().slice(0, 10);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'producto';
}

function isActiveOffer(product) {
  const salePrice = safeNumber(product.sale_price, 0);

  if (!salePrice || salePrice <= 0) return false;

  const today = new Date().toISOString().slice(0, 10);
  const start = normalizeDate(product.sale_start_date);
  const end = normalizeDate(product.sale_end_date);

  if (start && today < start) return false;
  if (end && today > end) return false;

  return true;
}

function calculatePricing(raw = {}) {
  const costPrice = safeNumber(raw.cost_price, 0);

  let regularPrice = safeNumber(
    raw.regular_price !== undefined ? raw.regular_price : raw.price,
    0
  );

  let salePrice = nullableNumber(raw.sale_price);
  let salePercent = safeNumber(raw.sale_percent, 0);
  const extraDiscountPercent = safeNumber(raw.extra_discount_percent, 0);

  if (!regularPrice && safeNumber(raw.price, 0)) {
    regularPrice = safeNumber(raw.price, 0);
  }

  if (salePercent > 100) salePercent = 100;
  if (salePercent < 0) salePercent = 0;

  if (extraDiscountPercent > 100) {
    throw new Error('El descuento adicional no puede ser mayor a 100%.');
  }

  if (extraDiscountPercent < 0) {
    throw new Error('El descuento adicional no puede ser negativo.');
  }

  if ((!salePrice || salePrice <= 0) && salePercent > 0 && regularPrice > 0) {
    salePrice = Number((regularPrice * (1 - salePercent / 100)).toFixed(2));
  }

  if ((!salePercent || salePercent <= 0) && salePrice && regularPrice > 0) {
    salePercent = Number((((regularPrice - salePrice) / regularPrice) * 100).toFixed(2));
  }

  let baseFinalPrice = salePrice && salePrice > 0 ? salePrice : regularPrice;

  let finalPriceAfterExtraDiscount = baseFinalPrice;

  if (extraDiscountPercent > 0 && baseFinalPrice > 0) {
    finalPriceAfterExtraDiscount = Number((baseFinalPrice * (1 - extraDiscountPercent / 100)).toFixed(2));
  }

  let minAllowedPrice = safeNumber(raw.min_allowed_price, 0);

  if (costPrice > 0 && (!minAllowedPrice || minAllowedPrice < costPrice)) {
    minAllowedPrice = costPrice;
  }

  if (costPrice > 0 && regularPrice > 0 && regularPrice < costPrice) {
    throw new Error(`El precio normal no puede estar por debajo del costo. Costo: RD$${costPrice}.`);
  }

  if (costPrice > 0 && salePrice && salePrice > 0 && salePrice < costPrice) {
    throw new Error(`El precio de oferta no puede estar por debajo del costo. Costo: RD$${costPrice}.`);
  }

  if (costPrice > 0 && finalPriceAfterExtraDiscount > 0 && finalPriceAfterExtraDiscount < costPrice) {
    throw new Error(`El descuento adicional deja el producto por debajo del costo. Costo: RD$${costPrice}.`);
  }

  return {
    cost_price: costPrice,
    price: regularPrice,
    regular_price: regularPrice,
    sale_price: salePrice,
    sale_percent: salePercent,
    extra_discount_percent: extraDiscountPercent,
    min_allowed_price: minAllowedPrice,
    effective_price: finalPriceAfterExtraDiscount || regularPrice || salePrice || 0
  };
}

function cleanBody(body = {}) {
  const pricing = calculatePricing(body);

  return {
    name: String(body.name || '').trim(),
    slug: body.slug ? slugify(body.slug) : '',
    short_description: body.short_description || '',
    description: body.description || '',
    brand_id: nullableNumber(body.brand_id),
    category_id: nullableNumber(body.category_id),
    model: body.model || '',
    type: body.type || 'simple',
    sku: body.sku || '',
    ...pricing,
    sale_start_date: normalizeDate(body.sale_start_date),
    sale_end_date: normalizeDate(body.sale_end_date),
    stock_quantity: safeNumber(body.stock_quantity, 0),
    stock_status: body.stock_status || 'instock',
    youtube_url: body.youtube_url || '',
    seo_keyword: body.seo_keyword || '',
    seo_title: body.seo_title || '',
    seo_description: body.seo_description || '',
    product_url: body.product_url || '',
    attributes: Array.isArray(body.attributes) ? body.attributes : []
  };
}

function productImageUrl(filename) {
  if (!filename) return null;

  if (String(filename).startsWith('http://') || String(filename).startsWith('https://')) {
    return filename;
  }

  return `${BACKEND_URL}/uploads/images/${filename}`;
}

function publicProductUrl(product) {
  if (product.product_url) return product.product_url;
  if (product.wp_product_id || product.woo_id) return product.permalink || '';

  const slug = product.slug || slugify(product.name || `producto-${product.id}`);

  return `${PUBLIC_APP_URL}/producto/${slug}`;
}

function formatProduct(product, user) {
  if (!product) return null;

  const activeOffer = isActiveOffer(product);
  const regularPrice = safeNumber(product.regular_price || product.price, 0);
  const salePrice = safeNumber(product.sale_price, 0);
  const extraDiscount = safeNumber(product.extra_discount_percent, 0);

  let visiblePrice = regularPrice;

  if (activeOffer && salePrice > 0) {
    visiblePrice = salePrice;
  }

  let finalPrice = visiblePrice;

  if (extraDiscount > 0 && visiblePrice > 0) {
    finalPrice = Number((visiblePrice * (1 - extraDiscount / 100)).toFixed(2));
  }

  const formatted = {
    ...product,
    price: regularPrice,
    regular_price: regularPrice,
    visible_price: visiblePrice,
    final_price: finalPrice,
    is_offer_active: activeOffer,
    offer_expires_at: product.sale_end_date || '',
    main_image_url: productImageUrl(product.main_image),
    image: productImageUrl(product.main_image),
    public_url: publicProductUrl(product),
    whatsapp_text: buildWhatsAppText({
      ...product,
      visible_price: visiblePrice,
      final_price: finalPrice,
      public_url: publicProductUrl(product)
    })
  };

  if (!canSeeCost(user)) {
    delete formatted.cost_price;
    delete formatted.min_allowed_price;
  }

  return formatted;
}

function buildWhatsAppText(product) {
  const price = safeNumber(product.final_price || product.visible_price || product.sale_price || product.regular_price || product.price, 0);
  const priceText = price > 0 ? `RD$${price.toLocaleString('es-DO')}` : 'Precio a consultar';

  return [
    `Hola, te comparto este producto:`,
    ``,
    `*${product.name || 'Producto'}*`,
    product.sku ? `Código/SKU: ${product.sku}` : '',
    `Precio: ${priceText}`,
    product.public_url ? `Ver producto: ${product.public_url}` : ''
  ].filter(Boolean).join('\n');
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

function getProductWithRelations(db, id, user) {
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

  const formatted = formatProduct(product, user);

  formatted.images = db.prepare(`
    SELECT *
    FROM product_images
    WHERE product_id = ?
    ORDER BY is_main DESC, sort_order ASC, id ASC
  `).all(id).map((image) => ({
    ...image,
    url: productImageUrl(image.filename)
  }));

  formatted.attributes = db.prepare(`
    SELECT *
    FROM product_attributes
    WHERE product_id = ?
    ORDER BY id ASC
  `).all(id);

  return formatted;
}

async function saveUploadedProductImage(file, productId, index = 0) {
  const imagesDir = path.join(__dirname, '..', 'uploads', 'images');

  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const ext = path.extname(file.originalname || file.filename || '').toLowerCase() || '.jpg';
  const finalExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
  const outName = `product_${productId}_${Date.now()}_${index}${finalExt}`;
  const outPath = path.join(imagesDir, outName);

  try {
    if (sharp) {
      await sharp(file.path)
        .resize(1200, 1200, {
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

  return outName;
}

async function downloadImageFromUrl(imageUrl, productId) {
  const cleanUrl = String(imageUrl || '').trim();

  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    throw new Error('La URL de imagen debe empezar con http:// o https://');
  }

  const imagesDir = path.join(__dirname, '..', 'uploads', 'images');

  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const response = await axios.get(cleanUrl, {
    timeout: 30000,
    responseType: 'arraybuffer'
  });

  const contentType = String(response.headers['content-type'] || '').toLowerCase();

  if (!contentType.includes('image')) {
    throw new Error('La URL no parece ser una imagen válida.');
  }

  const ext = contentType.includes('png')
    ? '.png'
    : contentType.includes('webp')
      ? '.webp'
      : '.jpg';

  const outName = `product_${productId}_url_${Date.now()}${ext}`;
  const outPath = path.join(imagesDir, outName);

  fs.writeFileSync(outPath, response.data);

  return outName;
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
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
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
    `).all(...params, safeLimit, offset).map((product) => formatProduct(product, req.user));

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
      outOfStock: stat("SELECT COUNT(*) AS c FROM products WHERE stock_status = 'outofstock'"),
      activeOffers: stat(`
        SELECT COUNT(*) AS c
        FROM products
        WHERE sale_price IS NOT NULL
          AND sale_price > 0
          AND (sale_start_date IS NULL OR sale_start_date = '' OR sale_start_date <= date('now'))
          AND (sale_end_date IS NULL OR sale_end_date = '' OR sale_end_date >= date('now'))
      `)
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

    const product = getProductWithRelations(db, req.params.id, req.user);

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

    const slug = data.slug || slugify(data.name);

    const result = db.prepare(`
      INSERT INTO products (
        name,
        slug,
        short_description,
        description,
        brand_id,
        category_id,
        model,
        type,
        sku,
        cost_price,
        price,
        regular_price,
        sale_price,
        sale_percent,
        extra_discount_percent,
        min_allowed_price,
        sale_start_date,
        sale_end_date,
        stock_quantity,
        stock_status,
        youtube_url,
        seo_keyword,
        seo_title,
        seo_description,
        product_url,
        status,
        created_by,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      data.name,
      slug,
      data.short_description,
      data.description,
      data.brand_id,
      data.category_id,
      data.model,
      data.type,
      data.sku,
      data.cost_price,
      data.price,
      data.regular_price,
      data.sale_price,
      data.sale_percent,
      data.extra_discount_percent,
      data.min_allowed_price,
      data.sale_start_date,
      data.sale_end_date,
      data.stock_quantity,
      data.stock_status,
      data.youtube_url,
      data.seo_keyword,
      data.seo_title,
      data.seo_description,
      data.product_url,
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
      product: getProductWithRelations(db, productId, req.user)
    });
  } catch (error) {
    console.error('[products] POST error:', error);

    res.status(400).json({
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

    if (req.user?.role === 'vendedor' && Number(product.created_by) !== Number(req.user.id)) {
      return res.status(403).json({
        error: 'No tienes permiso para editar este producto'
      });
    }

    const merged = {
      ...product,
      ...(req.body || {})
    };

    const data = cleanBody(merged);
    const slug = data.slug || product.slug || slugify(data.name || product.name);

    db.prepare(`
      UPDATE products
      SET
        name = ?,
        slug = ?,
        short_description = ?,
        description = ?,
        brand_id = ?,
        category_id = ?,
        model = ?,
        type = ?,
        sku = ?,
        cost_price = ?,
        price = ?,
        regular_price = ?,
        sale_price = ?,
        sale_percent = ?,
        extra_discount_percent = ?,
        min_allowed_price = ?,
        sale_start_date = ?,
        sale_end_date = ?,
        stock_quantity = ?,
        stock_status = ?,
        youtube_url = ?,
        seo_keyword = ?,
        seo_title = ?,
        seo_description = ?,
        product_url = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      data.name || product.name,
      slug,
      data.short_description,
      data.description,
      data.brand_id,
      data.category_id,
      data.model,
      data.type,
      data.sku,
      data.cost_price,
      data.price,
      data.regular_price,
      data.sale_price,
      data.sale_percent,
      data.extra_discount_percent,
      data.min_allowed_price,
      data.sale_start_date,
      data.sale_end_date,
      data.stock_quantity,
      data.stock_status,
      data.youtube_url,
      data.seo_keyword,
      data.seo_title,
      data.seo_description,
      data.product_url,
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
      product: getProductWithRelations(db, req.params.id, req.user)
    });
  } catch (error) {
    console.error('[products] PUT error:', error);

    res.status(400).json({
      error: 'Error actualizando producto: ' + error.message
    });
  }
});

// PATCH /api/products/:id/pricing
router.patch('/:id/pricing', authMiddleware, requireRole('superadmin', 'admin', 'contabilidad'), (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Producto no encontrado'
      });
    }

    const data = calculatePricing({
      ...product,
      ...(req.body || {})
    });

    db.prepare(`
      UPDATE products
      SET
        cost_price = ?,
        price = ?,
        regular_price = ?,
        sale_price = ?,
        sale_percent = ?,
        extra_discount_percent = ?,
        min_allowed_price = ?,
        sale_start_date = ?,
        sale_end_date = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      data.cost_price,
      data.price,
      data.regular_price,
      data.sale_price,
      data.sale_percent,
      data.extra_discount_percent,
      data.min_allowed_price,
      normalizeDate(req.body.sale_start_date || product.sale_start_date),
      normalizeDate(req.body.sale_end_date || product.sale_end_date),
      req.params.id
    );

    logActivity(db, req.user?.id, 'pricing_update', 'product', req.params.id);

    res.json({
      message: 'Precios actualizados correctamente',
      product: getProductWithRelations(db, req.params.id, req.user)
    });
  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

// POST /api/products/:id/validate-price
router.post('/:id/validate-price', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

    if (!product) {
      return res.status(404).json({
        valid: false,
        error: 'Producto no encontrado'
      });
    }

    const requestedPrice = safeNumber(req.body.price, 0);
    const cost = safeNumber(product.cost_price, 0);
    const min = safeNumber(product.min_allowed_price, cost);

    if (cost > 0 && requestedPrice < cost) {
      return res.status(400).json({
        valid: false,
        error: `No se puede vender por debajo del costo. Costo: RD$${cost}.`,
        cost_price: canSeeCost(req.user) ? cost : undefined,
        min_allowed_price: canSeeCost(req.user) ? min : undefined
      });
    }

    if (min > 0 && requestedPrice < min) {
      return res.status(400).json({
        valid: false,
        error: `No se puede vender por debajo del precio mínimo permitido. Mínimo: RD$${min}.`,
        min_allowed_price: canSeeCost(req.user) ? min : undefined
      });
    }

    res.json({
      valid: true,
      message: 'Precio permitido'
    });
  } catch (error) {
    res.status(500).json({
      valid: false,
      error: error.message
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

    const validStatuses = ['draft', 'pending', 'approved', 'published', 'rejected', 'archived'];

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
router.post('/:id/images', authMiddleware, uploadImages.array('images', 20), async (req, res) => {
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

    const mainIndex = Number(req.body.main_index || 0);
    const existingMain = db.prepare(`
      SELECT id
      FROM product_images
      WHERE product_id = ? AND is_main = 1
      LIMIT 1
    `).get(req.params.id);

    const saved = [];

    for (let i = 0; i < req.files.length; i++) {
      const filename = await saveUploadedProductImage(req.files[i], req.params.id, i);

      const makeMain = !existingMain && i === mainIndex ? 1 : 0;

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
      `).run(req.params.id, filename, makeMain, (count?.c || 0) + i);

      saved.push({
        id: result.lastInsertRowid,
        filename,
        is_main: makeMain,
        url: productImageUrl(filename)
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

// POST /api/products/:id/images/from-url
router.post('/:id/images/from-url', authMiddleware, async (req, res) => {
  try {
    const db = getDb();

    ensureProductsSchema(db);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Producto no encontrado'
      });
    }

    const { url, is_main } = req.body;

    if (!url) {
      return res.status(400).json({
        error: 'URL de imagen requerida'
      });
    }

    const filename = await downloadImageFromUrl(url, req.params.id);

    if (is_main) {
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
    `).run(
      req.params.id,
      filename,
      is_main ? 1 : 0,
      count?.c || 0
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      filename,
      is_main: is_main ? 1 : 0,
      url: productImageUrl(filename)
    });
  } catch (error) {
    res.status(400).json({
      error: 'Error agregando imagen desde URL: ' + error.message
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
