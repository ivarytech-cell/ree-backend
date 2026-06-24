const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

const SECRET_MASK = '••••••••';

const DEFAULT_SETTINGS = {
  app_name: 'Panel IA',
  app_logo: '',
  app_primary_color: '#2563eb',

  business_name: 'REElectrosistemas',
  support_email: '',
  whatsapp_phone: '',

  ai_enabled: '1',
  ai_name: 'Asistente IA',
  ai_welcome_message: 'Hola, soy tu asistente virtual. ¿En qué puedo ayudarte?',
  ai_personality: 'Profesional, claro, amable, experto en ventas y soporte técnico.',
  ai_business_context: 'Asistente virtual para orientar clientes, responder preguntas, recomendar productos y apoyar al equipo comercial.',
  ai_model: 'claude-haiku-4-5-20251001',

  ai_escalation_enabled: '1',
  ai_escalation_keywords: 'comprar,cotizar,precio,asesor,humano,garantía,reclamo,problema,pedido,urgente',
  ai_auto_assign: '1',

  anthropic_key: '',
  openai_key: '',

  wc_url: '',
  wc_key: '',
  wc_secret: ''
};

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const SECRET_KEYS = new Set(['anthropic_key', 'openai_key', 'wc_secret']);

function ensureSettingsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS attribute_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      unit TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');

  Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => {
    stmt.run(key, value);
  });
}

function getSettings(db, options = {}) {
  const maskSecrets = options.maskSecrets !== false;

  ensureSettingsSchema(db);

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { ...DEFAULT_SETTINGS };

  rows.forEach((row) => {
    settings[row.key] = row.value;
  });

  if (maskSecrets) {
    SECRET_KEYS.forEach((key) => {
      if (settings[key]) {
        settings[key] = SECRET_MASK;
      }
    });
  }

  return settings;
}

function saveSettings(db, body) {
  ensureSettingsSchema(db);

  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const updated = [];

  Object.entries(body || {}).forEach(([key, value]) => {
    if (!ALLOWED_KEYS.has(key)) return;

    if (SECRET_KEYS.has(key) && value === SECRET_MASK) return;

    const cleanValue = value === null || value === undefined ? '' : String(value);

    stmt.run(key, cleanValue);
    updated.push(key);
  });

  return updated;
}

// GET /api/settings
router.get('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const db = getDb();
    const settings = getSettings(db, { maskSecrets: true });

    res.json(settings);
  } catch (error) {
    console.error('Settings GET error:', error);
    res.status(500).json({ error: 'Error cargando configuración: ' + error.message });
  }
});

// GET /api/settings/public
// Sirve para que el frontend pueda mostrar nombre, logo y mensaje de bienvenida sin exponer claves.
router.get('/public', (req, res) => {
  try {
    const db = getDb();
    const settings = getSettings(db, { maskSecrets: true });

    res.json({
      app_name: settings.app_name,
      app_logo: settings.app_logo,
      app_primary_color: settings.app_primary_color,
      business_name: settings.business_name,
      ai_enabled: settings.ai_enabled,
      ai_name: settings.ai_name,
      ai_welcome_message: settings.ai_welcome_message,
      whatsapp_phone: settings.whatsapp_phone,
      support_email: settings.support_email
    });
  } catch (error) {
    console.error('Settings public error:', error);
    res.status(500).json({ error: 'Error cargando configuración pública: ' + error.message });
  }
});

// PUT /api/settings
router.put('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const db = getDb();
    const updated = saveSettings(db, req.body);

    res.json({
      message: 'Configuración guardada correctamente',
      updated
    });
  } catch (error) {
    console.error('Settings PUT error:', error);
    res.status(500).json({ error: 'Error guardando configuración: ' + error.message });
  }
});

// PATCH /api/settings
router.patch('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const db = getDb();
    const updated = saveSettings(db, req.body);

    res.json({
      message: 'Configuración actualizada correctamente',
      updated
    });
  } catch (error) {
    console.error('Settings PATCH error:', error);
    res.status(500).json({ error: 'Error actualizando configuración: ' + error.message });
  }
});

// POST /api/settings/test-ai
router.post('/test-ai', authMiddleware, requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const settings = getSettings(db, { maskSecrets: false });

    const apiKey = settings.anthropic_key || process.env.ANTHROPIC_API_KEY || '';

    if (!apiKey || apiKey.length < 10) {
      return res.status(400).json({
        ok: false,
        error: 'No hay clave de Claude AI configurada.'
      });
    }

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: settings.ai_model || 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [
        {
          role: 'user',
          content: 'Responde solamente: conexión correcta.'
        }
      ]
    });

    res.json({
      ok: true,
      message: message.content?.[0]?.text || 'Conexión correcta.'
    });
  } catch (error) {
    console.error('AI test error:', error);
    res.status(500).json({
      ok: false,
      error: 'Error probando IA: ' + error.message
    });
  }
});

// GET /api/settings/attributes
router.get('/attributes', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    ensureSettingsSchema(db);

    const attrs = db.prepare('SELECT * FROM attribute_templates ORDER BY name').all();

    res.json(attrs);
  } catch (error) {
    console.error('Attributes GET error:', error);
    res.status(500).json({ error: 'Error cargando atributos: ' + error.message });
  }
});

// POST /api/settings/attributes
router.post('/attributes', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const { name, unit } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nombre requerido' });
    }

    const db = getDb();
    ensureSettingsSchema(db);

    const result = db
      .prepare('INSERT INTO attribute_templates (name, unit) VALUES (?, ?)')
      .run(name, unit || '');

    res.status(201).json({
      id: result.lastInsertRowid,
      name,
      unit: unit || ''
    });
  } catch (error) {
    console.error('Attributes POST error:', error);
    res.status(500).json({ error: 'Error creando atributo: ' + error.message });
  }
});

// DELETE /api/settings/attributes/:id
router.delete('/attributes/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const db = getDb();
    ensureSettingsSchema(db);

    db.prepare('DELETE FROM attribute_templates WHERE id = ?').run(req.params.id);

    res.json({ message: 'Atributo eliminado' });
  } catch (error) {
    console.error('Attributes DELETE error:', error);
    res.status(500).json({ error: 'Error eliminando atributo: ' + error.message });
  }
});

module.exports = router;
