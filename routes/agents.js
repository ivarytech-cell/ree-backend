const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.get('/teams', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM teams ORDER BY name').all());
});
router.post('/teams', authMiddleware, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const r = getDb().prepare('INSERT INTO teams (name, description) VALUES (?,?)').run(name, description || '');
  res.json({ id: r.lastInsertRowid, name });
});
router.delete('/teams/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM teams WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/online', authMiddleware, (req, res) => {
  res.json(getDb().prepare("SELECT id, name, last_name, role, status, avatar_color FROM agents WHERE status='available' ORDER BY name").all());
});

router.get('/', authMiddleware, (req, res) => {
  const agents = getDb().prepare('SELECT a.*, t.name as team_name FROM agents a LEFT JOIN teams t ON a.team_id = t.id ORDER BY a.name').all();
  res.json(agents.map(a => ({ ...a, password_hash: undefined })));
});

router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const agent = db.prepare('SELECT a.*, t.name as team_name FROM agents a LEFT JOIN teams t ON a.team_id=t.id WHERE a.id=?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agente no encontrado' });
  const { password_hash, ...safe } = agent;
  const load = db.prepare("SELECT COUNT(*) as n FROM conversations WHERE assigned_agent_id=? AND status='open'").get(agent.id);
  res.json({ ...safe, open_conversations: load?.n || 0 });
});

router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, last_name, email, username, password, role, team_id, avatar_color } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Nombre, usuario y contraseña requeridos' });
  try {
    const r = db.prepare('INSERT INTO agents (name, last_name, email, username, password_hash, role, team_id, avatar_color) VALUES (?,?,?,?,?,?,?,?)').run(name, last_name || '', email || '', username, bcrypt.hashSync(password, 10), role || 'vendedor', team_id || null, avatar_color || '#3b82f6');
    res.json({ id: r.lastInsertRowid, name, username });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'El usuario ya existe' });
    throw e;
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  const { name, last_name, email, role, team_id, avatar_color, notification_sounds } = req.body;
  getDb().prepare('UPDATE agents SET name=?, last_name=?, email=?, role=?, team_id=?, avatar_color=?, notification_sounds=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, last_name || '', email || '', role, team_id || null, avatar_color || '#3b82f6', notification_sounds ? JSON.stringify(notification_sounds) : '{}', req.params.id);
  res.json({ success: true });
});

router.delete('/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM agents WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.put('/:id/status', authMiddleware, (req, res) => {
  const { status } = req.body;
  if (!['available', 'away', 'offline'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  getDb().prepare('UPDATE agents SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ success: true, status });
});

module.exports = router;
