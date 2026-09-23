const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { generateToken, authMiddleware, requireAdmin } = require('../auth');

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username dan password wajib diisi.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Username atau password salah.' });
  }

  const isMatch = bcrypt.compareSync(password, user.password_hash);
  if (!isMatch) {
    return res.status(401).json({ success: false, error: 'Username atau password salah.' });
  }

  const token = generateToken(user);
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      allowed_groups: user.allowed_groups
    }
  });
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, name, role, allowed_groups, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User tidak ditemukan.' });
  }
  res.json({ success: true, user });
});

// GET /api/auth/users (Admin only)
router.get('/users', authMiddleware, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, allowed_groups, created_at FROM users ORDER BY id ASC').all();
  res.json({ success: true, users });
});

// POST /api/auth/users (Admin only)
router.post('/users', authMiddleware, requireAdmin, (req, res) => {
  const { username, password, name, role, allowed_groups } = req.body;
  if (!username || !password || !name) {
    return res.status(400).json({ success: false, error: 'Username, password, dan nama wajib diisi.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(400).json({ success: false, error: 'Username tersebut sudah terdaftar.' });
  }

  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);

  const insert = db.prepare(`
    INSERT INTO users (username, password_hash, name, role, allowed_groups)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = insert.run(username, hash, name, role || 'user', allowed_groups || '*');
  res.json({
    success: true,
    message: 'User berhasil dibuat.',
    userId: result.lastInsertRowid
  });
});

// DELETE /api/auth/users/:id (Admin only)
router.delete('/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ success: false, error: 'Anda tidak dapat menghapus akun Anda sendiri.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ success: true, message: 'User berhasil dihapus.' });
});

module.exports = router;

