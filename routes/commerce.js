const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_COMMERCE = {
  business_name: 'REElectrosistemas',
  address: '',
  city: '',
  country: '',
  phone: '',
  email: '',
  website: '',
  facebook: '',
  instagram: '',
  whatsapp: '',
  currency_primary: 'DOP',
  currency_secondary: 'USD',
  rnc: '',
  business_hours: '',
  logo_url: '',
  description: '',
  primary_color: '#2563eb',

  brand_primary_color: '#2563eb',
  brand_secondary_color: '#111827',
  brand_accent_color: '#f59e0b',
  brand_background_color: '#ffffff',
  brand_text_color: '#111827',
  brand_heading_font: 'Montserrat',
  brand_body_font: 'Inter',
  brand_visual_style: 'Moderno / tech',
  brand_tone: 'Profesional, claro, confiable y comercial.',
  brand_slogan: '',
  brand_hashtags: '',
  brand_do: 'Usar mensajes claros, beneficios concretos y llamados a la acción directos.',
  brand_dont: 'No exagerar, no inventar especificaciones y no usar diseños cargados.',
  brand_prompt_guidelines: 'Diseño profesional, limpio, buena iluminación, producto protagonista, lectura clara y composición comercial.',
  brand_offer_terms: '',
  brand_target_audience: 'Clientes residenciales, comerciales e industriales.',
  image_default_format: '4:5',
  image_default_style: 'Moderno / tech',
  image_include_phone: '1',
  image_include_instagram: '1',
  image_include_logo: '1'
};

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_COMMERCE));

function ensureCommerceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_info (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const stmt = db.prepare('INSERT OR IGNORE INTO commerce_info (key, value) VALUES (?, ?)');

  Object.entries(DEFAULT_COMMERCE).forEach(([key, value]) => {
    stmt.run(key, value);
  });
}

function getCommerceInfo(db) {
  ensureCommerceSchema(db);

  const rows = db.prepare('SELECT key, value FROM commerce_info').all();
  const info = { ...DEFAULT_COMMERCE };

  rows.forEach((row) => {
    info[row.key] = row.value;
  });

  return info;
}

function saveCommerceInfo(db, body = {}) {
  ensureCommerceSchema(db);

  const stmt = db.prepare('INSERT OR REPLACE INTO commerce_info (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
  const updated = [];

  Object.entries(body).forEach(([key, value]) => {
    if (!ALLOWED_KEYS.has(key)) return;

    stmt.run(key, value === null || value === undefined ? '' : String(value));
    updated.push(key);
  });

  return updated;
}

router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const info = getCommerceInfo(db);

    res.json(info);
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando Mi Comercio: ' + error.message
    });
  }
});

router.get('/brand', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const info = getCommerceInfo(db);

    res.json(info);
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando línea gráfica: ' + error.message
    });
  }
});

router.get('/config', (req, res) => {
  try {
    const db = getDb();
    const info = getCommerceInfo(db);

    res.json({
      app_name: info.business_name || 'Mi Empresa',
      business_name: info.business_name || 'Mi Empresa',
      logo_url: info.logo_url || null,
      app_logo: info.logo_url || null,
      primary_color: info.primary_color || info.brand_primary_color || '#3b82f6',
      app_primary_color: info.primary_color || info.brand_primary_color || '#3b82f6',
      currency: info.currency_primary || 'DOP',
      phone: info.phone || '',
      whatsapp: info.whatsapp || '',
      instagram: info.instagram || '',
      brand_visual_style: info.brand_visual_style || 'Moderno / tech',
      brand_heading_font: info.brand_heading_font || 'Montserrat',
      brand_body_font: info.brand_body_font || 'Inter',
      brand_slogan: info.brand_slogan || ''
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando configuración pública: ' + error.message
    });
  }
});

router.put('/', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const updated = saveCommerceInfo(db, req.body || {});

    res.json({
      success: true,
      message: 'Mi Comercio actualizado correctamente.',
      updated
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error guardando Mi Comercio: ' + error.message
    });
  }
});

router.put('/brand', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const updated = saveCommerceInfo(db, req.body || {});

    res.json({
      success: true,
      message: 'Línea gráfica guardada correctamente.',
      updated
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error guardando línea gráfica: ' + error.message
    });
  }
});

module.exports = router;
