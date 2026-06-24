const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');
const router = express.Router();

router.get('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  res.json(getDb().prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at DESC').all());
});

router.post('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'Todos los campos son requeridos' });
  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(400).json({ error: 'Email ya registrado' });
  const result = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)').run(name, email, bcrypt.hashSync(password, 10), role);
  res.status(201).json({ id: result.lastInsertRowid, name, email, role });
});

router.put('/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const { name, email, role, active, password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  let extra = '';
  const params = [name || user.name, email || user.email, role || user.role, active ?? user.active];
  if (password && password.length >= 8) { extra = ', password = ?'; params.push(bcrypt.hashSync(password, 10)); }
  params.push(req.params.id);
  db.prepare(`UPDATE users SET name = ?, email = ?, role = ?, active = ?${extra} WHERE id = ?`).run(...params);
  res.json({ message: 'Usuario actualizado' });
});

router.delete('/:id', authMiddleware, requireRole('superadmin'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte' });
  getDb().prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ message: 'Usuario eliminado' });
});

module.exports = router;
