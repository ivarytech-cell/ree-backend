// routes/merkalectro.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

function getClient() {
  const db = getDb();
  let key;
  try { key = db.prepare("SELECT value FROM settings WHERE key='anthropic_key'").get()?.value; } catch {}
  if (!key) key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('No hay clave de Claude configurada');
  return new Anthropic({ apiKey: key });
}

router.get('/guides', authMiddleware, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM knowledge_guides ORDER BY updated_at DESC').all());
});

router.get('/guides/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const guide = db.prepare('SELECT * FROM knowledge_guides WHERE id=?').get(req.params.id);
  if (!guide) return res.status(404).json({ error: 'Guía no encontrada' });
  const instructions = db.prepare('SELECT * FROM guide_instructions WHERE guide_id=? ORDER BY order_index').all(guide.id);
  const qa = db.prepare('SELECT * FROM guide_qa WHERE guide_id=? ORDER BY order_index').all(guide.id);
  res.json({ ...guide, instructions, qa });
});

router.post('/guides', authMiddleware, (req, res) => {
  const db = getDb();
  const { title, topic, content, guide_type } = req.body;
  if (!title) return res.status(400).json({ error: 'Título requerido' });
  const author = req.user?.name || 'Admin';
  const result = db.prepare(
    'INSERT INTO knowledge_guides (title, topic, content, guide_type, author) VALUES (?,?,?,?,?)'
  ).run(title, topic || '', content || '', guide_type || 'general', author);
  res.json({ id: result.lastInsertRowid, title, topic, content, guide_type, author });
});

router.put('/guides/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const { title, topic, content, guide_type, is_active } = req.body;
  db.prepare(
    'UPDATE knowledge_guides SET title=?, topic=?, content=?, guide_type=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(title, topic, content, guide_type, is_active ?? 1, req.params.id);
  res.json({ success: true });
});

router.delete('/guides/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM knowledge_guides WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.post('/guides/:id/instructions', authMiddleware, (req, res) => {
  const db = getDb();
  const { instruction, order_index } = req.body;
  if (!instruction) return res.status(400).json({ error: 'Instrucción requerida' });
  const result = db.prepare(
    'INSERT INTO guide_instructions (guide_id, instruction, order_index) VALUES (?,?,?)'
  ).run(req.params.id, instruction, order_index || 0);
  res.json({ id: result.lastInsertRowid, instruction });
});

router.delete('/guides/:id/instructions/:iid', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM guide_instructions WHERE id=? AND guide_id=?').run(req.params.iid, req.params.id);
  res.json({ success: true });
});

router.post('/guides/:id/qa', authMiddleware, (req, res) => {
  const db = getDb();
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Pregunta y respuesta requeridas' });
  const result = db.prepare(
    'INSERT INTO guide_qa (guide_id, question, answer) VALUES (?,?,?)'
  ).run(req.params.id, question, answer);
  res.json({ id: result.lastInsertRowid, question, answer });
});

router.delete('/guides/:id/qa/:qid', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM guide_qa WHERE id=? AND guide_id=?').run(req.params.qid, req.params.id);
  res.json({ success: true });
});

router.post('/guides/:id/improve', authMiddleware, async (req, res) => {
  const db = getDb();
  const guide = db.prepare('SELECT * FROM knowledge_guides WHERE id=?').get(req.params.id);
  if (!guide) return res.status(404).json({ error: 'Guía no encontrada' });
  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: `Mejora el siguiente contenido de la guía "${guide.title}" en español:\n\n${guide.content || '(vacío)'}` }]
    });
    res.json({ improved: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/guides/generate', authMiddleware, async (req, res) => {
  const { business_info, guide_type } = req.body;
  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `Crea una guía de conocimiento de tipo "${guide_type || 'general'}" para:\n\n${business_info}\n\nEn español, estructurada y clara.` }]
    });
    res.json({ content: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
