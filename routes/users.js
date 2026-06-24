const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/users - solo admin y superadmin
router.get('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// POST /api/users - crear usuario
router.post('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'Todos los campos son requeridos' });

  // Solo superadmin puede crear admins
  if (role === 'superadmin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Solo el superadmin puede crear superadmins' });
  }
  if (role === 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Solo el superadmin puede crear admins' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: 'El email ya está registrado' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)').run(name, email, hash, role);
  res.status(201).json({ id: result.lastInsertRowid, name, email, role });
});

// PUT /api/users/:id - actualizar usuario
router.put('/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const { name, email, role, active, password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // No puede cambiar superadmin si no es superadmin
  if (user.role === 'superadmin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'No puedes editar un superadmin' });
  }

  let updatePwd = '';
  const params = [name || user.name, email || user.email, role || user.role, active ?? user.active];

  if (password && password.length >= 8) {
    updatePwd = ', password = ?';
    params.push(bcrypt.hashSync(password, 10));
  }

  params.push(req.params.id);
  db.prepare(`UPDATE users SET name = ?, email = ?, role = ?, active = ?${updatePwd} WHERE id = ?`).run(...params);
  res.json({ message: 'Usuario actualizado' });
});

// DELETE /api/users/:id
router.delete('/:id', authMiddleware, requireRole('superadmin'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  }
  const db = getDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ message: 'Usuario eliminado' });
});

module.exports = router;
