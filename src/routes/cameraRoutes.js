const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

// GET /api/cameras - Multi-search and filter
router.get('/', authMiddleware, (req, res) => {
  const { q, group_id, device_id } = req.query;

  let sql = `
    SELECT c.*, 
           d.name AS device_name, d.ip AS device_ip, d.status AS device_status,
           g.name AS group_name
    FROM cameras c
    JOIN devices d ON d.id = c.device_id
    LEFT JOIN groups g ON g.id = c.group_id
    WHERE 1=1
  `;
  const params = [];

  // Group permission filtering for non-admin users
  if (req.user.role !== 'admin' && req.user.allowed_groups && req.user.allowed_groups !== '*') {
    try {
      const allowed = JSON.parse(req.user.allowed_groups);
      if (Array.isArray(allowed) && allowed.length > 0) {
        sql += ` AND c.group_id IN (${allowed.map(() => '?').join(',')})`;
        params.push(...allowed);
      }
    } catch (e) {}
  }

  // Group filter from query
  if (group_id) {
    sql += ' AND c.group_id = ?';
    params.push(parseInt(group_id, 10));
  }

  // Device filter from query
  if (device_id) {
    sql += ' AND c.device_id = ?';
    params.push(parseInt(device_id, 10));
  }

  // Search query: searches in camera name, channel number, tags, device name, or device IP
  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    sql += ` AND (
      c.custom_name LIKE ? 
      OR c.tags LIKE ? 
      OR CAST(c.channel_no AS TEXT) = ? 
      OR d.name LIKE ? 
      OR d.ip LIKE ?
      OR g.name LIKE ?
    )`;
    params.push(term, term, q.trim(), term, term, term);
  }

  sql += ' ORDER BY d.name ASC, c.channel_no ASC';

  const cameras = db.prepare(sql).all(...params);
  res.json({ success: true, count: cameras.length, cameras });
});

// GET /api/cameras/:id
router.get('/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const camera = db.prepare(`
    SELECT c.*, 
           d.name AS device_name, d.ip AS device_ip, d.status AS device_status,
           g.name AS group_name
    FROM cameras c
    JOIN devices d ON d.id = c.device_id
    LEFT JOIN groups g ON g.id = c.group_id
    WHERE c.id = ?
  `).get(id);

  if (!camera) {
    return res.status(404).json({ success: false, error: 'Kamera tidak ditemukan.' });
  }

  res.json({ success: true, camera });
});

// PUT /api/cameras/:id - Edit Camera (Rename, Tags, Group)
router.put('/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { custom_name, tags, group_id, is_active } = req.body;

  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
  if (!camera) {
    return res.status(404).json({ success: false, error: 'Kamera tidak ditemukan.' });
  }

  const newName = custom_name ? custom_name.trim() : camera.custom_name;
  const newTags = tags !== undefined ? tags.trim() : camera.tags;
  const newGroupId = group_id !== undefined ? (group_id ? parseInt(group_id, 10) : null) : camera.group_id;
  const newActive = is_active !== undefined ? (is_active ? 1 : 0) : camera.is_active;

  db.prepare(`
    UPDATE cameras
    SET custom_name = ?, tags = ?, group_id = ?, is_active = ?
    WHERE id = ?
  `).run(newName, newTags, newGroupId, newActive, id);

  res.json({ success: true, message: 'Data kamera berhasil diperbarui.' });
});

// POST /api/cameras/:id/stream - Register stream with go2rtc and get web player URL
router.post('/:id/stream', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const camera = db.prepare(`
    SELECT c.*, d.ip, d.rtsp_port, d.username, d.password, d.name AS device_name
    FROM cameras c
    JOIN devices d ON d.id = c.device_id
    WHERE c.id = ?
  `).get(id);

  if (!camera) {
    return res.status(404).json({ success: false, error: 'Kamera tidak ditemukan.' });
  }

  const streamName = `cam_${id}`;
  
  // Default to Main Stream (1080p Full HD) for maximum clarity and native framerate.
  // Can be switched to sub stream if explicitly requested (?quality=sub).
  const streamQuality = req.query.quality || req.body.quality || 'main';
  const rtspUrl = streamQuality === 'sub'
    ? (camera.sub_stream_url || camera.main_stream_url)
    : (camera.main_stream_url || camera.sub_stream_url);

  try {
    // Delete existing stream from go2rtc cache to ensure new settings apply
    await fetch(`http://127.0.0.1:1984/api/streams?name=${encodeURIComponent(streamName)}`, { method: 'DELETE' }).catch(() => {});

    // Direct native RTSP first (0% CPU, zero delay, native framerate)
    // Hardware-accelerated H.264 fallback second (QSV / MediaFoundation / GPU)
    const transcodeSrc = `ffmpeg:${rtspUrl}#video=h264#hardware`;
    const putUrl = `http://127.0.0.1:1984/api/streams?name=${encodeURIComponent(streamName)}&src=${encodeURIComponent(rtspUrl)}&src=${encodeURIComponent(transcodeSrc)}`;
    await fetch(putUrl, { method: 'PUT' }).catch(() => {});

    const host = req.hostname || 'localhost';
    res.json({
      success: true,
      streamName,
      quality: streamQuality,
      playerUrl: `/media/stream.html?src=${encodeURIComponent(streamName)}&mode=webrtc,mse,mp4`,
      wsUrl: `/media/api/ws?src=${encodeURIComponent(streamName)}`,
      mp4Url: `/media/api/stream.mp4?src=${encodeURIComponent(streamName)}`,
      rtspUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/cameras/:id/playback-stream - Register playback stream with go2rtc
router.post('/:id/playback-stream', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { startTime, endTime, playbackURI } = req.body;

  const camera = db.prepare(`
    SELECT c.*, d.ip, d.http_port, d.rtsp_port, d.username, d.password, d.name AS device_name
    FROM cameras c
    JOIN devices d ON d.id = c.device_id
    WHERE c.id = ?
  `).get(id);

  if (!camera) {
    return res.status(404).json({ success: false, error: 'Kamera tidak ditemukan.' });
  }

  const device = {
    ip: camera.ip,
    http_port: camera.http_port,
    rtsp_port: camera.rtsp_port || 554,
    username: camera.username,
    password: camera.password
  };

  const hikvision = require('../services/hikvision');
  const playbackRtspUrl = hikvision.generatePlaybackRTSPUrl(device, camera.channel_no, startTime, endTime, playbackURI);
  const streamName = `playback_${id}`;

  try {
    // Delete existing stream first if active to reset RTSP session
    await fetch(`http://127.0.0.1:1984/api/streams?name=${encodeURIComponent(streamName)}`, { method: 'DELETE' }).catch(() => {});

    // Direct RTSP first for zero latency, with hardware H.264 transcode fallback
    const transcodeSrc = `ffmpeg:${playbackRtspUrl}#video=h264#hardware`;
    const putUrl = `http://127.0.0.1:1984/api/streams?name=${encodeURIComponent(streamName)}&src=${encodeURIComponent(playbackRtspUrl)}&src=${encodeURIComponent(transcodeSrc)}`;
    await fetch(putUrl, { method: 'PUT' }).catch(() => {});

    const host = req.hostname || 'localhost';
    res.json({
      success: true,
      streamName,
      playerUrl: `/media/stream.html?src=${encodeURIComponent(streamName)}&mode=webrtc,mse,mp4`,
      wsUrl: `/media/api/ws?src=${encodeURIComponent(streamName)}`,
      mp4Url: `/media/api/stream.mp4?src=${encodeURIComponent(streamName)}`,
      rtspUrl: playbackRtspUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/cameras/:id/month-recordings - Get dates that have recordings on NVR in a given month
router.get('/:id/month-recordings', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const now = new Date();
  const year = req.query.year || now.getFullYear();
  const month = req.query.month || (now.getMonth() + 1);

  const camera = db.prepare(`
    SELECT c.*, d.ip, d.http_port, d.username, d.password, d.name AS device_name
    FROM cameras c
    JOIN devices d ON d.id = c.device_id
    WHERE c.id = ?
  `).get(id);

  if (!camera) {
    return res.status(404).json({ success: false, error: 'Kamera tidak ditemukan.' });
  }

  const device = {
    ip: camera.ip,
    http_port: camera.http_port,
    username: camera.username,
    password: camera.password
  };

  const hikvision = require('../services/hikvision');
  try {
    const result = await hikvision.getMonthlyRecordDistribution(device, camera.channel_no, year, month);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, recordedDates: [], recordedDays: [] });
  }
});

// In-memory cache for camera snapshots to avoid overwhelming NVR ISAPI sockets
const snapshotCache = new Map(); // id -> { buffer, contentType, timestamp, hasSignal }

// GET /api/cameras/:id/snapshot - Live Snapshot JPEG from NVR with smart caching
router.get('/:id/snapshot', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const now = Date.now();

  const cached = snapshotCache.get(id);
  if (cached) {
    const cacheTtl = cached.hasSignal ? 4000 : 15000; // 4s for live images, 15s for empty channels
    if (now - cached.timestamp < cacheTtl) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=4');
      return res.send(cached.buffer);
    }
  }

  const camera = db.prepare(`
    SELECT c.*, d.ip, d.http_port, d.username, d.password, d.status AS device_status, d.name AS device_name
    FROM cameras c
    JOIN devices d ON d.id = c.device_id
    WHERE c.id = ?
  `).get(id);

  if (!camera) {
    return res.status(404).send('Camera not found');
  }

  const hikvision = require('../services/hikvision');
  const device = {
    ip: camera.ip,
    http_port: camera.http_port,
    username: camera.username,
    password: camera.password
  };

  try {
    const snapRes = await hikvision.getSnapshot(device, camera.channel_no);
    if (snapRes.statusCode === 200) {
      const chunks = [];
      snapRes.on('data', chunk => chunks.push(chunk));
      snapRes.on('end', () => {
        const buffer = Buffer.concat(chunks);
        snapshotCache.set(id, {
          buffer,
          contentType: 'image/jpeg',
          timestamp: Date.now(),
          hasSignal: true
        });
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=4');
          res.send(buffer);
        }
      });
      return;
    }
  } catch (e) {
    // Channel offline or no camera connected
  }

  // Return clean, dark CCTV "No Video Signal" placeholder
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <rect width="640" height="360" fill="#080c14"/>
      <line x1="0" y1="0" x2="640" y2="360" stroke="#161f30" stroke-width="1"/>
      <line x1="640" y1="0" x2="0" y2="360" stroke="#161f30" stroke-width="1"/>
      <circle cx="320" cy="150" r="34" fill="#0f172a" stroke="#334155" stroke-width="1.5"/>
      <path d="M312 142 L328 158 M328 142 L312 158" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>
      <text x="320" y="210" font-family="sans-serif" font-size="13" font-weight="bold" fill="#94a3b8" text-anchor="middle">TIDAK ADA SINYAL VIDEO</text>
      <text x="320" y="232" font-family="sans-serif" font-size="11" fill="#64748b" text-anchor="middle">CH ${String(camera.channel_no).padStart(2, '0')} • ${camera.custom_name}</text>
      <text x="320" y="250" font-family="monospace" font-size="10" fill="#475569" text-anchor="middle">Port belum terpasang kamera fisik</text>
      <rect x="16" y="16" width="70" height="20" rx="4" fill="#0f172a" stroke="#1e293b" stroke-width="1"/>
      <circle cx="26" cy="26" r="3.5" fill="#64748b"/>
      <text x="36" y="29" font-family="monospace" font-size="9" font-weight="bold" fill="#94a3b8">NO SIGNAL</text>
    </svg>
  `.trim();

  const svgBuffer = Buffer.from(svg);
  snapshotCache.set(id, {
    buffer: svgBuffer,
    contentType: 'image/svg+xml',
    timestamp: Date.now(),
    hasSignal: false
  });

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=15');
  res.send(svgBuffer);
});

module.exports = router;

