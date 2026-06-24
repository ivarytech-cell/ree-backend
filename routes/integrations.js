// routes/integrations.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

const parseConfig = (i) => { try { return { ...i, config: JSON.parse(i.config || '{}') }; } catch { return { ...i, config: {} }; } };

router.get('/', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM integrations ORDER BY category, name').all().map(parseConfig));
});

router.get('/:id', authMiddleware, (req, res) => {
  const i = getDb().prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!i) return res.status(404).json({ error: 'Integración no encontrada' });
  res.json(parseConfig(i));
});

router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const { config, is_connected, webhook_url } = req.body;
  const existing = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No encontrada' });
  let merged = {}; try { merged = JSON.parse(existing.config || '{}'); } catch {}
  if (config) Object.assign(merged, config);
  db.prepare('UPDATE integrations SET config=?, is_connected=?, webhook_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(merged), is_connected ? 1 : 0, webhook_url || existing.webhook_url, req.params.id);
  res.json({ success: true });
});

router.post('/:id/connect', authMiddleware, (req, res) => {
  const db = getDb();
  const { config } = req.body;
  const existing = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No encontrada' });
  let merged = {}; try { merged = JSON.parse(existing.config || '{}'); } catch {}
  if (config) Object.assign(merged, config);
  db.prepare('UPDATE integrations SET config=?, is_connected=1, connected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(merged), req.params.id);
  res.json({ success: true, message: `${existing.name} conectado` });
});

router.post('/:id/disconnect', authMiddleware, (req, res) => {
  getDb().prepare('UPDATE integrations SET is_connected=0, connected_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/test', authMiddleware, async (req, res) => {
  const db = getDb();
  const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!integration) return res.status(404).json({ error: 'No encontrada' });
  let config = {}; try { config = JSON.parse(integration.config || '{}'); } catch {}
  try {
    if (integration.type === 'claude') {
      const Anthropic = require('@anthropic-ai/sdk');
      const key = config.api_key || process.env.ANTHROPIC_API_KEY;
      if (!key) return res.status(400).json({ error: 'Sin API key' });
      const client = new Anthropic({ apiKey: key });
      await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      return res.json({ success: true, message: 'Claude AI conectado correctamente' });
    }
    if (integration.type === 'openai') {
      const axios = require('axios');
      const key = config.api_key || process.env.OPENAI_API_KEY;
      if (!key) return res.status(400).json({ error: 'Sin API key' });
      await axios.get('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      return res.json({ success: true, message: 'OpenAI conectado correctamente' });
    }
    res.json({ success: true, message: 'Configuración guardada.' });
  } catch (err) {
    res.status(400).json({ error: err.response?.data?.error?.message || err.message });
  }
});

module.exports = router;
