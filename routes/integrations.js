const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

const SECRET_MASK = '••••••••';

const DEFAULT_INTEGRATIONS = [
  {
    name: 'WooCommerce REST API',
    type: 'woocommerce',
    category: 'ecommerce',
    config: {}
  },
  {
    name: 'WordPress',
    type: 'wordpress',
    category: 'ecommerce',
    config: {}
  },
  {
    name: 'Claude AI',
    type: 'claude_ai',
    category: 'ai',
    config: {
      model: 'claude-haiku-4-5-20251001'
    }
  },
  {
    name: 'ChatGPT / OpenAI',
    type: 'openai',
    category: 'ai',
    config: {}
  },
  {
    name: 'OpenAI Imágenes',
    type: 'openai_images',
    category: 'image_ai',
    config: {
      model: 'gpt-image-1',
      size: '1024x1024',
      quality: 'medium'
    }
  },
  {
    name: 'Claude Design / Prompt Visual',
    type: 'claude_design',
    category: 'image_ai',
    config: {
      model: 'claude-haiku-4-5-20251001',
      prompt_base: 'Crea un prompt visual profesional para una imagen comercial de producto.'
    }
  },
  {
    name: 'WhatsApp Business',
    type: 'whatsapp',
    category: 'messaging',
    config: {}
  },
  {
    name: 'Facebook Messenger',
    type: 'messenger',
    category: 'messaging',
    config: {}
  },
  {
    name: 'Instagram DM',
    type: 'instagram_dm',
    category: 'messaging',
    config: {}
  },
  {
    name: 'Meta Ads',
    type: 'meta_ads',
    category: 'marketing',
    config: {}
  },
  {
    name: 'Google Ads',
    type: 'google_ads',
    category: 'marketing',
    config: {}
  }
];

function ensureSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

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

function ensureIntegrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT DEFAULT 'other',
      is_connected INTEGER DEFAULT 0,
      config TEXT DEFAULT '{}',
      webhook_url TEXT,
      connected_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  addColumnIfMissing(db, 'integrations', 'name', 'TEXT');
  addColumnIfMissing(db, 'integrations', 'type', 'TEXT');
  addColumnIfMissing(db, 'integrations', 'category', "TEXT DEFAULT 'other'");
  addColumnIfMissing(db, 'integrations', 'is_connected', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'integrations', 'config', "TEXT DEFAULT '{}'");
  addColumnIfMissing(db, 'integrations', 'webhook_url', 'TEXT');
  addColumnIfMissing(db, 'integrations', 'connected_at', 'DATETIME');
  addColumnIfMissing(db, 'integrations', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
  addColumnIfMissing(db, 'integrations', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');

  DEFAULT_INTEGRATIONS.forEach((item) => {
    const existing = db.prepare('SELECT rowid, * FROM integrations WHERE type = ? ORDER BY rowid ASC LIMIT 1').get(item.type);

    if (existing) {
      db.prepare(`
        UPDATE integrations
        SET
          name = ?,
          category = ?,
          config = CASE WHEN config IS NULL OR config = '' THEN ? ELSE config END,
          updated_at = CURRENT_TIMESTAMP
        WHERE rowid = ?
      `).run(
        item.name,
        item.category,
        JSON.stringify(item.config || {}),
        existing.rowid
      );
    } else {
      db.prepare(`
        INSERT INTO integrations (
          name,
          type,
          category,
          config,
          is_connected,
          updated_at
        )
        VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
      `).run(
        item.name,
        item.type,
        item.category,
        JSON.stringify(item.config || {})
      );
    }
  });

  // Elimina duplicados dejando solo el primer registro de cada tipo.
  try {
    db.prepare(`
      DELETE FROM integrations
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM integrations
        WHERE type IS NOT NULL AND type != ''
        GROUP BY type
      )
      AND type IS NOT NULL
      AND type != ''
    `).run();
  } catch (error) {
    console.error('No se pudieron limpiar duplicados de integraciones:', error.message);
  }
}

function parseConfig(value) {
  if (!value) return {};

  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    return {};
  }
}

function normalizeUrl(url) {
  if (!url) return '';

  let clean = String(url).trim();

  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'https://' + clean;
  }

  return clean.replace(/\/+$/, '');
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
  ensureSettingsTable(db);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value || '');
}

function getSettings(db) {
  ensureSettingsTable(db);

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};

  rows.forEach((row) => {
    settings[row.key] = row.value;
  });

  return settings;
}

function getWooConfigFromSettingsAndConfig(db, config = {}) {
  const settings = getSettings(db);

  let legacy = {};

  try {
    legacy = settings.woocommerce_config ? JSON.parse(settings.woocommerce_config) : {};
  } catch (error) {
    legacy = {};
  }

  const url = normalizeUrl(
    config.wc_url ||
    config.woo_url ||
    config.url ||
    settings.wc_url ||
    legacy.wc_url ||
    legacy.woo_url ||
    process.env.WC_URL ||
    ''
  );

  const key = String(
    config.wc_key ||
    config.woo_key ||
    config.key ||
    settings.wc_key ||
    legacy.wc_key ||
    legacy.woo_key ||
    process.env.WC_KEY ||
    ''
  ).trim();

  let secret =
    config.wc_secret ||
    config.woo_secret ||
    config.secret ||
    settings.wc_secret ||
    legacy.wc_secret ||
    legacy.woo_secret ||
    process.env.WC_SECRET ||
    '';

  if (secret === SECRET_MASK || secret === '***') {
    secret = settings.wc_secret || legacy.wc_secret || legacy.woo_secret || process.env.WC_SECRET || '';
  }

  secret = String(secret || '').trim();

  return {
    url,
    key,
    secret
  };
}

function saveWooConfigToSettings(db, config = {}) {
  const current = getWooConfigFromSettingsAndConfig(db, {});
  const finalConfig = getWooConfigFromSettingsAndConfig(db, {
    ...current,
    ...config
  });

  saveSetting(db, 'wc_url', finalConfig.url);
  saveSetting(db, 'wc_key', finalConfig.key);
  saveSetting(db, 'wc_secret', finalConfig.secret);

  saveSetting(
    db,
    'woocommerce_config',
    JSON.stringify({
      wc_url: finalConfig.url,
      wc_key: finalConfig.key,
      wc_secret: finalConfig.secret,
      woo_url: finalConfig.url,
      woo_key: finalConfig.key,
      woo_secret: finalConfig.secret
    })
  );

  return finalConfig;
}

function validateWooConfig(config) {
  if (!config.url) return 'Falta la URL del sitio WooCommerce.';
  if (!config.key) return 'Falta el Consumer Key de WooCommerce.';
  if (!config.secret) return 'Falta el Consumer Secret de WooCommerce.';
  if (!config.key.startsWith('ck_')) return 'El Consumer Key debe empezar con ck_.';
  if (!config.secret.startsWith('cs_')) return 'El Consumer Secret debe empezar con cs_.';

  return null;
}

async function testWooCommerce(config) {
  const validationError = validateWooConfig(config);

  if (validationError) {
    throw new Error(validationError);
  }

  try {
    const response = await axios.get(`${config.url}/wp-json/wc/v3/products`, {
      timeout: 30000,
      params: {
        per_page: 1
      },
      auth: {
        username: config.key,
        password: config.secret
      }
    });

    return {
      success: true,
      message: `WooCommerce conectado correctamente. Productos detectados: ${response.headers['x-wp-total'] || '?'}.`
    };
  } catch (firstError) {
    const response = await axios.get(`${config.url}/wp-json/wc/v3/products`, {
      timeout: 30000,
      params: {
        per_page: 1,
        consumer_key: config.key,
        consumer_secret: config.secret
      }
    });

    return {
      success: true,
      message: `WooCommerce conectado correctamente. Productos detectados: ${response.headers['x-wp-total'] || '?'}.`
    };
  }
}

async function testClaude(config = {}) {
  const db = getDb();
  const settings = getSettings(db);

  const apiKey =
    config.api_key ||
    config.anthropic_key ||
    settings.anthropic_key ||
    process.env.ANTHROPIC_API_KEY ||
    '';

  if (!apiKey) {
    throw new Error('Falta el API Key de Claude / Anthropic.');
  }

  const client = new Anthropic({
    apiKey
  });

  await client.messages.create({
    model: config.model || settings.ai_model || 'claude-haiku-4-5-20251001',
    max_tokens: 30,
    messages: [
      {
        role: 'user',
        content: 'Responde solamente: conectado.'
      }
    ]
  });

  saveSetting(db, 'anthropic_key', apiKey);

  if (config.model) {
    saveSetting(db, 'ai_model', config.model);
  }

  return {
    success: true,
    message: 'Claude AI conectado correctamente.'
  };
}

async function testOpenAI(config = {}) {
  const db = getDb();
  const settings = getSettings(db);

  const apiKey =
    config.api_key ||
    config.openai_key ||
    settings.openai_key ||
    process.env.OPENAI_API_KEY ||
    '';

  if (!apiKey) {
    throw new Error('Falta el API Key de OpenAI.');
  }

  await axios.get('https://api.openai.com/v1/models', {
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  saveSetting(db, 'openai_key', apiKey);

  return {
    success: true,
    message: 'OpenAI conectado correctamente.'
  };
}

function cleanIntegrationForResponse(row) {
  const config = parseConfig(row.config);
  const safeConfig = { ...config };

  [
    'api_key',
    'access_token',
    'secret',
    'wc_secret',
    'woo_secret',
    'openai_key',
    'anthropic_key'
  ].forEach((key) => {
    if (safeConfig[key]) {
      safeConfig[key] = SECRET_MASK;
    }
  });

  return {
    ...row,
    is_connected: Number(row.is_connected || 0) === 1,
    config: safeConfig
  };
}

function findIntegration(db, idOrType) {
  return db
    .prepare('SELECT rowid, * FROM integrations WHERE CAST(id AS TEXT) = ? OR type = ? LIMIT 1')
    .get(String(idOrType), String(idOrType));
}

function updateIntegration(db, idOrType, data = {}) {
  ensureIntegrationsTable(db);

  const existing = findIntegration(db, idOrType);

  if (!existing) {
    throw new Error('Integración no encontrada.');
  }

  const oldConfig = parseConfig(existing.config);
  const newConfig = {
    ...oldConfig,
    ...(data.config || {})
  };

  const nextConnected = data.is_connected === undefined
    ? Number(existing.is_connected || 0)
    : data.is_connected ? 1 : 0;

  db.prepare(`
    UPDATE integrations
    SET
      config = ?,
      is_connected = ?,
      webhook_url = ?,
      connected_at = CASE WHEN ? = 1 THEN COALESCE(connected_at, CURRENT_TIMESTAMP) ELSE connected_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE rowid = ?
  `).run(
    JSON.stringify(newConfig),
    nextConnected,
    data.webhook_url || existing.webhook_url || '',
    nextConnected,
    existing.rowid
  );

  return db.prepare('SELECT rowid, * FROM integrations WHERE rowid = ?').get(existing.rowid);
}

// GET /api/integrations
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureSettingsTable(db);
    ensureIntegrationsTable(db);

    const rows = db
      .prepare('SELECT rowid, * FROM integrations ORDER BY category, name')
      .all()
      .map(cleanIntegrationForResponse);

    res.json(rows);
  } catch (error) {
    console.error('[integrations] GET error:', error);
    res.status(500).json({
      error: 'Error cargando integraciones: ' + error.message
    });
  }
});

// POST /api/integrations/bootstrap
router.post('/bootstrap', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb();

    ensureSettingsTable(db);
    ensureIntegrationsTable(db);

    const rows = db
      .prepare('SELECT rowid, * FROM integrations ORDER BY category, name')
      .all()
      .map(cleanIntegrationForResponse);

    res.json({
      success: true,
      message: 'Integraciones restauradas correctamente.',
      integrations: rows
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error restaurando integraciones: ' + error.message
    });
  }
});

// GET /api/integrations/:id
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    ensureSettingsTable(db);
    ensureIntegrationsTable(db);

    const row = findIntegration(db, req.params.id);

    if (!row) {
      return res.status(404).json({
        error: 'Integración no encontrada.'
      });
    }

    res.json(cleanIntegrationForResponse(row));
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando integración: ' + error.message
    });
  }
});

// PUT /api/integrations/:id
router.put('/:id', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb();

    ensureSettingsTable(db);
    ensureIntegrationsTable(db);

    const updated = updateIntegration(db, req.params.id, {
      config: req.body?.config || {},
      is_connected: req.body?.is_connected,
      webhook_url: req.body?.webhook_url
    });

    if (updated.type === 'woocommerce') {
      saveWooConfigToSettings(db, req.body?.config || {});
    }

    res.json({
      success: true,
      message: 'Integración guardada correctamente.',
      integration: cleanIntegrationForResponse(updated)
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error guardando integración: ' + error.message
    });
  }
});

// POST /api/integrations/:id/connect
router.post('/:id/connect', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb();

    ensureSettingsTable(db);
    ensureIntegrationsTable(db);

    const existing = findIntegration(db, req.params.id);

    if (!existing) {
      return res.status(404).json({
        error: 'Integración no encontrada.'
      });
    }

    const config = {
      ...parseConfig(existing.config),
      ...(req.body?.config || {})
    };

    let result = {
      success: true,
      message: 'Integración conectada correctamente.'
    };

    if (existing.type === 'woocommerce') {
      const wooConfig = saveWooConfigToSettings(db, config);
      result = await testWooCommerce(wooConfig);
    }

    if (existing.type === 'claude_ai' || existing.type === 'claude_design') {
      result = await testClaude(config);
    }

    if (existing.type === 'openai' || existing.type === 'openai_images') {
      result = await testOpenAI(config);
    }

    const updated = updateIntegration(db, existing.rowid, {
      config,
      is_connected: true,
      webhook_url: req.body?.webhook_url
    });

    res.json({
      success: true,
      message: result.message || 'Integración conectada correctamente.',
      integration: cleanIntegrationForResponse(updated)
    });
  } catch (error) {
    console.error('[integrations] connect error:', error.response?.data || error.message);

    res.status(400).json({
      success: false,
      error: error.response?.data?.message || error.response?.data?.error?.message || error.message
    });
  }
});

// POST /api/integrations/:id/test
router.post('/:id/test', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb();

    ensureSettingsTable(db);
    ensureIntegrationsTable(db);

    const existing = findIntegration(db, req.params.id);

    if (!existing) {
      return res.status(404).json({
        error: 'Integración no encontrada.'
      });
    }

    const config = {
      ...parseConfig(existing.config),
      ...(req.body?.config || {})
    };

    let result = {
      success: true,
      message: 'La integración está disponible para configurar.'
    };

    if (existing.type === 'woocommerce') {
      const wooConfig = saveWooConfigToSettings(db, config);
      result = await testWooCommerce(wooConfig);
    } else if (existing.type === 'claude_ai' || existing.type === 'claude_design') {
      result = await testClaude(config);
    } else if (existing.type === 'openai' || existing.type === 'openai_images') {
      result = await testOpenAI(config);
    }

    const updated = updateIntegration(db, existing.rowid, {
      config,
      is_connected: true
    });

    res.json({
      success: true,
      message: result.message,
      integration: cleanIntegrationForResponse(updated)
    });
  } catch (error) {
    console.error('[integrations] test error:', error.response?.data || error.message);

    res.status(400).json({
      success: false,
      error: error.response?.data?.message || error.response?.data?.error?.message || error.message
    });
  }
});

// POST /api/integrations/:id/disconnect
router.post('/:id/disconnect', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb();

    ensureSettingsTable(db);
    ensureIntegrationsTable(db);

    const existing = findIntegration(db, req.params.id);

    if (!existing) {
      return res.status(404).json({
        error: 'Integración no encontrada.'
      });
    }

    db.prepare(`
      UPDATE integrations
      SET
        is_connected = 0,
        connected_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE rowid = ?
    `).run(existing.rowid);

    res.json({
      success: true,
      message: 'Integración desconectada correctamente.'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error desconectando integración: ' + error.message
    });
  }
});

module.exports = router;
