const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { uploadImages } = require('../middleware/upload');

const router = express.Router();

// GET /api/brands
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const brands = db.prepare('SELECT * FROM brands ORDER BY name').all();
  res.json(brands);
});

// POST /api/brands
router.post('/', authMiddleware, requireRole('superadmin', 'admin'), uploadImages.single('logo'), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });

  const db = getDb();
  const logo = req.file ? req.file.filename : null;
  const result = db.prepare('INSERT INTO brands (name, logo) VALUES (?, ?)').run(name, logo);
  res.status(201).json({ id: result.lastInsertRowid, name, logo });
});

// PUT /api/brands/:id
router.put('/:id', authMiddleware, requireRole('superadmin', 'admin'), uploadImages.single('logo'), (req, res) => {
  const { name } = req.body;
  const db = getDb();
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
  if (!brand) return res.status(404).json({ error: 'Marca no encontrada' });

  const logo = req.file ? req.file.filename : brand.logo;
  db.prepare('UPDATE brands SET name = ?, logo = ? WHERE id = ?').run(name || brand.name, logo, req.params.id);
  res.json({ message: 'Marca actualizada' });
});

// DELETE /api/brands/:id
router.delete('/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const db = getDb();
  const inUse = db.prepare('SELECT COUNT(*) as c FROM products WHERE brand_id = ?').get(req.params.id);
  if (inUse.c > 0) return res.status(400).json({ error: 'La marca tiene productos asignados' });
  db.prepare('DELETE FROM brands WHERE id = ?').run(req.params.id);
  res.json({ message: 'Marca eliminada' });
});

module.exports = router;
