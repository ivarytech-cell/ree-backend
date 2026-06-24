// routes/integrations.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const integrations = db.prepare('SELECT * FROM integrations ORDER BY category, name').all();
  res.json(integrations.map(i => ({
    ...i,
    config: (() => { try { return JSON.parse(i.config || '{}'); } catch { return {}; } })()
  })));
});

router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!integration) return res.status(404).json({ error: 'Integración no encontrada' });
  try { integration.config = JSON.parse(integration.config || '{}'); } catch {}
  res.json(integration);
});

router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const { config, is_connected, webhook_url } = req.body;
  const existing = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Integración no encontrada' });

  let mergedConfig = {};
  try { mergedConfig = JSON.parse(existing.config || '{}'); } catch {}
  if (config) Object.assign(mergedConfig, config);

  db.prepare(
    'UPDATE integrations SET config=?, is_connected=?, webhook_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(JSON.stringify(mergedConfig), is_connected ? 1 : 0, webhook_url || existing.webhook_url, req.params.id);

  res.json({ success: true });
});

// Connect / disconnect
router.post('/:id/connect', authMiddleware, (req, res) => {
  const db = getDb();
  const { config } = req.body;
  const existing = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Integración no encontrada' });

  let mergedConfig = {};
  try { mergedConfig = JSON.parse(existing.config || '{}'); } catch {}
  if (config) Object.assign(mergedConfig, config);

  db.prepare(
    'UPDATE integrations SET config=?, is_connected=1, connected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(JSON.stringify(mergedConfig), req.params.id);

  res.json({ success: true, message: `${existing.name} conectado correctamente` });
});

router.post('/:id/disconnect', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare(
    'UPDATE integrations SET is_connected=0, connected_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(req.params.id);
  res.json({ success: true });
});

// Test connection for AI integrations
router.post('/:id/test', authMiddleware, async (req, res) => {
  const db = getDb();
  const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!integration) return res.status(404).json({ error: 'Integración no encontrada' });

  let config = {};
  try { config = JSON.parse(integration.config || '{}'); } catch {}

  try {
    if (integration.type === 'claude') {
      const Anthropic = require('@anthropic-ai/sdk');
      const key = config.api_key || process.env.ANTHROPIC_API_KEY;
      if (!key) return res.status(400).json({ error: 'No hay API key configurada' });
      const client = new Anthropic({ apiKey: key });
      const r = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      return res.json({ success: true, message: 'Claude AI conectado correctamente' });
    }
    if (integration.type === 'openai') {
      const axios = require('axios');
      const key = config.api_key || process.env.OPENAI_API_KEY;
      if (!key) return res.status(400).json({ error: 'No hay API key configurada' });
      await axios.get('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      return res.json({ success: true, message: 'OpenAI conectado correctamente' });
    }
    res.json({ success: true, message: 'Configuración guardada. Conecta para probar.' });
  } catch (err) {
    res.status(400).json({ error: err.response?.data?.error?.message || err.message });
  }
});

module.exports = router;
