const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_INTEGRATIONS = [
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    type: 'woocommerce',
    category: 'commerce',
    config: {}
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    type: 'wordpress',
    category: 'commerce',
    config: {}
  },
  {
    id: 'claude_ai',
    name: 'Claude AI',
    type: 'claude',
    category: 'ai',
    config: {}
  },
  {
    id: 'openai',
    name: 'ChatGPT / OpenAI',
    type: 'openai',
    category: 'ai',
    config: {}
  },
  {
    id: 'openai_images',
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
    id: 'claude_design',
    name: 'Claude Design / Prompt Visual',
    type: 'claude_design',
    category: 'image_ai',
    config: {
      model: 'claude-haiku-4-5-20251001',
      prompt_base: 'Crea un prompt visual profesional para generar una imagen comercial del producto.'
    }
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    type: 'whatsapp',
    category: 'messaging',
    config: {}
  },
  {
    id: 'messenger',
    name: 'Facebook Messenger',
    type: 'messenger',
    category: 'messaging',
    config: {}
  },
  {
    id: 'instagram_dm',
    name: 'Instagram DM',
    type: 'instagram_dm',
    category: 'messaging',
    config: {}
  },
  {
    id: 'meta_ads',
    name: 'Meta Ads',
    type: 'meta_ads',
    category: 'marketing',
    config: {}
  },
  {
    id: 'google_ads',
    name: 'Google Ads',
    type: 'google_ads',
    category: 'marketing',
    config: {}
  }
];

function ensureIntegrations() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT DEFAULT 'messaging',
      config TEXT DEFAULT '{}',
      is_connected INTEGER DEFAULT 0,
      webhook_url TEXT,
      connected_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO integrations (
      id,
      name,
      type,
      category,
      config,
      is_connected,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
  `);

  DEFAULT_INTEGRATIONS.forEach((item) => {
    stmt.run(
      item.id,
      item.name,
      item.type,
      item.category,
      JSON.stringify(item.config || {})
    );
  });
}

function parseConfig(integration) {
  try {
    return {
      ...integration,
      is_connected: Number(integration.is_connected || 0),
      config: JSON.parse(integration.config || '{}')
    };
  } catch (error) {
    return {
      ...integration,
      is_connected: Number(integration.is_connected || 0),
      config: {}
    };
  }
}

function getSettingsConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};

  rows.forEach((row) => {
    settings[row.key] = row.value;
  });

  return settings;
}

function normalizeUrl(url) {
  if (!url) return '';

  let clean = String(url).trim();

  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'https://' + clean;
  }

  return clean.replace(/\/+$/, '');
}

async function testWooCommerce(config = {}) {
  const settings = getSettingsConfig();

  const url = normalizeUrl(config.wc_url || config.url || settings.wc_url || process.env.WC_URL || '');
  const key = String(config.wc_key || config.key || settings.wc_key || process.env.WC_KEY || '').trim();
  const secret = String(config.wc_secret || config.secret || settings.wc_secret || process.env.WC_SECRET || '').trim();

  if (!url || !key || !secret) {
    throw new Error('Faltan datos de WooCommerce. Guarda URL, Consumer Key y Consumer Secret.');
  }

  if (!key.startsWith('ck_')) {
    throw new Error('El Consumer Key debe empezar con ck_.');
  }

  if (!secret.startsWith('cs_')) {
    throw new Error('El Consumer Secret debe empezar con cs_.');
  }

  try {
    const response = await axios.get(`${url}/wp-json/wc/v3/products`, {
      timeout: 30000,
      params: {
        per_page: 1
      },
      auth: {
        username: key,
        password: secret
      }
    });

    return {
      success: true,
      message: `WooCommerce conectado correctamente. Productos detectados: ${response.headers['x-wp-total'] || '?'}.`
    };
  } catch (firstError) {
    const response = await axios.get(`${url}/wp-json/wc/v3/products`, {
      timeout: 30000,
      params: {
        per_page: 1,
        consumer_key: key,
        consumer_secret: secret
      }
    });

    return {
      success: true,
      message: `WooCommerce conectado correctamente. Productos detectados: ${response.headers['x-wp-total'] || '?'}.`
    };
  }
}

async function testClaude(config = {}) {
  const key = config.api_key || process.env.ANTHROPIC_API_KEY;

  if (!key) {
    throw new Error('Sin API Key de Claude.');
  }

  const client = new Anthropic({
    apiKey: key
  });

  await client.messages.create({
    model: config.model || 'claude-haiku-4-5-20251001',
    max_tokens: 20,
    messages: [
      {
        role: 'user',
        content: 'Responde solamente: conectado'
      }
    ]
  });

  return {
    success: true,
    message: 'Claude AI conectado correctamente.'
  };
}

async function testOpenAI(config = {}) {
  const key = config.api_key || process.env.OPENAI_API_KEY;

  if (!key) {
    throw new Error('Sin API Key de OpenAI.');
  }

  await axios.get('https://api.openai.com/v1/models', {
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${key}`
    }
  });

  return {
    success: true,
    message: 'OpenAI conectado correctamente.'
  };
}

// GET /api/integrations
router.get('/', authMiddleware, (req, res) => {
  try {
    ensureIntegrations();

    const integrations = getDb()
      .prepare('SELECT * FROM integrations ORDER BY category, name')
      .all()
      .map(parseConfig);

    res.json(integrations);
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando integraciones: ' + error.message
    });
  }
});

// POST /api/integrations/bootstrap
router.post('/bootstrap', authMiddleware, (req, res) => {
  try {
    ensureIntegrations();

    const integrations = getDb()
      .prepare('SELECT * FROM integrations ORDER BY category, name')
      .all()
      .map(parseConfig);

    res.json({
      success: true,
      message: 'Integraciones restauradas correctamente',
      integrations
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
    ensureIntegrations();

    const integration = getDb()
      .prepare('SELECT * FROM integrations WHERE id = ?')
      .get(req.params.id);

    if (!integration) {
      return res.status(404).json({
        error: 'Integración no encontrada'
      });
    }

    res.json(parseConfig(integration));
  } catch (error) {
    res.status(500).json({
      error: 'Error cargando integración: ' + error.message
    });
  }
});

// PUT /api/integrations/:id
router.put('/:id', authMiddleware, (req, res) => {
  try {
    ensureIntegrations();

    const db = getDb();
    const { config, is_connected, webhook_url } = req.body;

    const existing = db
      .prepare('SELECT * FROM integrations WHERE id = ?')
      .get(req.params.id);

    if (!existing) {
      return res.status(404).json({
        error: 'Integración no encontrada'
      });
    }

    let merged = {};

    try {
      merged = JSON.parse(existing.config || '{}');
    } catch (error) {}

    if (config) {
      Object.assign(merged, config);
    }

    db.prepare(`
      UPDATE integrations
      SET
        config = ?,
        is_connected = ?,
        webhook_url = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      JSON.stringify(merged),
      is_connected ? 1 : 0,
      webhook_url || existing.webhook_url || '',
      req.params.id
    );

    res.json({
      success: true,
      message: 'Integración actualizada correctamente'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error actualizando integración: ' + error.message
    });
  }
});

// POST /api/integrations/:id/connect
router.post('/:id/connect', authMiddleware, (req, res) => {
  try {
    ensureIntegrations();

    const db = getDb();
    const { config } = req.body;

    const existing = db
      .prepare('SELECT * FROM integrations WHERE id = ?')
      .get(req.params.id);

    if (!existing) {
      return res.status(404).json({
        error: 'Integración no encontrada'
      });
    }

    let merged = {};

    try {
      merged = JSON.parse(existing.config || '{}');
    } catch (error) {}

    if (config) {
      Object.assign(merged, config);
    }

    db.prepare(`
      UPDATE integrations
      SET
        config = ?,
        is_connected = 1,
        connected_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(merged), req.params.id);

    res.json({
      success: true,
      message: `${existing.name} conectado correctamente`
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error conectando integración: ' + error.message
    });
  }
});

// POST /api/integrations/:id/disconnect
router.post('/:id/disconnect', authMiddleware, (req, res) => {
  try {
    ensureIntegrations();

    getDb()
      .prepare(`
        UPDATE integrations
        SET
          is_connected = 0,
          connected_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(req.params.id);

    res.json({
      success: true,
      message: 'Integración desconectada'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error desconectando integración: ' + error.message
    });
  }
});

// POST /api/integrations/:id/test
router.post('/:id/test', authMiddleware, async (req, res) => {
  try {
    ensureIntegrations();

    const db = getDb();

    const integration = db
      .prepare('SELECT * FROM integrations WHERE id = ?')
      .get(req.params.id);

    if (!integration) {
      return res.status(404).json({
        error: 'Integración no encontrada'
      });
    }

    let savedConfig = {};

    try {
      savedConfig = JSON.parse(integration.config || '{}');
    } catch (error) {}

    const config = {
      ...savedConfig,
      ...(req.body?.config || {})
    };

    let result;

    if (integration.type === 'woocommerce') {
      result = await testWooCommerce(config);
    } else if (integration.type === 'claude') {
      result = await testClaude(config);
    } else if (integration.type === 'openai' || integration.type === 'openai_images') {
      result = await testOpenAI(config);
    } else {
      result = {
        success: true,
        message: 'La integración está disponible para configurar.'
      };
    }

    db.prepare(`
      UPDATE integrations
      SET
        is_connected = 1,
        connected_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);

    res.json(result);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.response?.data?.message || error.response?.data?.error?.message || error.message
    });
  }
});

module.exports = router;
