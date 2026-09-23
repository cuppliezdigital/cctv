const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

// GET /api/groups
router.get('/', authMiddleware, (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, 
           (SELECT COUNT(*) FROM devices d WHERE d.group_id = g.id) AS device_count,
           (SELECT COUNT(*) FROM cameras c WHERE c.group_id = g.id) AS camera_count
    FROM groups g
    ORDER BY g.name ASC
  `).all();
  res.json({ success: true, groups });
});

// POST /api/groups (Admin only)
router.post('/', authMiddleware, requireAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Nama grup tidak boleh kosong.' });
  }

  try {
    const insert = db.prepare('INSERT INTO groups (name, description) VALUES (?, ?)');
    const result = insert.run(name.trim(), description ? description.trim() : '');
    res.json({ success: true, groupId: result.lastInsertRowid, message: 'Grup berhasil ditambahkan.' });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, error: 'Nama grup tersebut sudah ada.' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/groups/:id (Admin only)
router.put('/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Nama grup tidak boleh kosong.' });
  }

  try {
    db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?').run(name.trim(), description || '', id);
    res.json({ success: true, message: 'Grup berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/groups/:id (Admin only)
router.delete('/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    db.prepare('UPDATE cameras SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('UPDATE devices SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    res.json({ success: true, message: 'Grup berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

