const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/categories
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const categories = db.prepare(`
    SELECT c.*, p.name as parent_name
    FROM categories c
    LEFT JOIN categories p ON c.parent_id = p.id
    ORDER BY c.name
  `).all();
  res.json(categories);
});

// POST /api/categories
router.post('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const { name, slug, parent_id, wp_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });

  const db = getDb();
  const slugFinal = slug || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const result = db.prepare('INSERT INTO categories (name, slug, parent_id, wp_id) VALUES (?, ?, ?, ?)').run(name, slugFinal, parent_id || null, wp_id || null);
  res.status(201).json({ id: result.lastInsertRowid, name, slug: slugFinal });
});

// PUT /api/categories/:id
router.put('/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const { name, slug, parent_id, wp_id } = req.body;
  const db = getDb();
  db.prepare('UPDATE categories SET name = ?, slug = ?, parent_id = ?, wp_id = ? WHERE id = ?')
    .run(name, slug, parent_id || null, wp_id || null, req.params.id);
  res.json({ message: 'Categoría actualizada' });
});

// DELETE /api/categories/:id
router.delete('/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const db = getDb();
  const inUse = db.prepare('SELECT COUNT(*) as c FROM products WHERE category_id = ?').get(req.params.id);
  if (inUse.c > 0) return res.status(400).json({ error: 'La categoría tiene productos asignados' });
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ message: 'Categoría eliminada' });
});

module.exports = router;
