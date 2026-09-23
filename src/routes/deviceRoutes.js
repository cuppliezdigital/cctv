const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');
const hikvision = require('../services/hikvision');

// GET /api/devices
router.get('/', authMiddleware, (req, res) => {
  const devices = db.prepare(`
    SELECT d.*, g.name AS group_name,
           (SELECT COUNT(*) FROM cameras c WHERE c.device_id = d.id) AS camera_count
    FROM devices d
    LEFT JOIN groups g ON g.id = d.group_id
    ORDER BY d.id DESC
  `).all();
  res.json({ success: true, devices });
});

// POST /api/devices/test - Test NVR connection before adding
router.post('/test', authMiddleware, requireAdmin, async (req, res) => {
  const { ip, http_port, username, password } = req.body;
  if (!ip || !username || !password) {
    return res.status(400).json({ success: false, error: 'IP, Username, dan Password wajib diisi.' });
  }

  const result = await hikvision.testConnection({
    ip,
    http_port: http_port || 80,
    username,
    password
  });

  res.json(result);
});

// GET /api/devices/sadp - Auto-discover Hikvision devices on LAN via SADP protocol
router.get('/sadp', authMiddleware, async (req, res) => {
  try {
    const devices = await hikvision.discoverSadpDevices(2000);
    res.json({ success: true, count: devices.length, devices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/devices/discover-serial - Auto locate device IP by Serial Number
router.post('/discover-serial', authMiddleware, requireAdmin, async (req, res) => {
  const { serial, username, password, subnet, hintIp } = req.body;
  if (!serial) {
    return res.status(400).json({ success: false, error: 'Nomor Seri wajib diisi.' });
  }

  const options = {};
  if (subnet) options.subnets = [subnet.trim()];
  if (hintIp) options.hintIp = hintIp.trim();

  try {
    const result = await hikvision.findDeviceBySerial(serial.trim(), { username, password }, options);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/devices - Add NVR & Auto-detect Channels & Real Names
router.post('/', authMiddleware, requireAdmin, async (req, res) => {
  const { name, group_id, ip, http_port, rtsp_port, username, password, channel_count } = req.body;
  if (!name || !ip || !username || !password) {
    return res.status(400).json({ success: false, error: 'Nama NVR, IP, Username, dan Password wajib diisi.' });
  }

  const hPort = parseInt(http_port, 10) || 80;
  const rPort = parseInt(rtsp_port, 10) || 554;
  const gId = group_id ? parseInt(group_id, 10) : null;

  try {
    const tempDev = {
      name: name.trim(),
      ip: ip.trim(),
      http_port: hPort,
      rtsp_port: rPort,
      username: username.trim(),
      password: password.trim()
    };

    // Auto-scan channels & native camera names from NVR
    const scanRes = await hikvision.scanNvrChannels(tempDev);
    const channelsToCreate = (scanRes.success && scanRes.channels.length > 0)
      ? scanRes.channels
      : null;

    const finalCount = channelsToCreate 
      ? channelsToCreate.length 
      : (parseInt(channel_count, 10) || 16);

    // Test connection & get real serial number and model if not provided
    let realSerial = req.body.serial_number ? req.body.serial_number.trim() : null;
    let realModel = req.body.model ? req.body.model.trim() : null;

    try {
      const conn = await hikvision.testConnection(tempDev);
      if (conn.success && conn.deviceInfo) {
        if (!realSerial && conn.deviceInfo.serialNumber) realSerial = conn.deviceInfo.serialNumber;
        if (!realModel && conn.deviceInfo.model) realModel = conn.deviceInfo.model;
      }
    } catch (e) {}

    // Insert device
    const insertDevice = db.prepare(`
      INSERT INTO devices (name, group_id, ip, http_port, rtsp_port, username, password, channel_count, status, serial_number, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)
    `);

    const result = insertDevice.run(
      name.trim(), gId, ip.trim(), hPort, rPort, username.trim(), password.trim(), finalCount, realSerial, realModel
    );
    const deviceId = result.lastInsertRowid;
    tempDev.id = deviceId;

    // Insert auto-detected channels
    const insertCamera = db.prepare(`
      INSERT INTO cameras (device_id, channel_no, custom_name, group_id, tags, main_stream_url, sub_stream_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    if (channelsToCreate) {
      for (const ch of channelsToCreate) {
        const { mainStream, subStream } = hikvision.generateRTSPUrls(tempDev, ch.channelNo);
        insertCamera.run(
          deviceId,
          ch.channelNo,
          ch.name, // Native name from NVR
          gId,
          `ch${ch.channelNo}, ${ch.model || ''}, ${name}`,
          mainStream,
          subStream
        );
      }
    } else {
      // Fallback if device is offline
      for (let ch = 1; ch <= finalCount; ch++) {
        const channelPadded = String(ch).padStart(2, '0');
        const cameraName = `${name} - Cam ${channelPadded}`;
        const { mainStream, subStream } = hikvision.generateRTSPUrls(tempDev, ch);
        insertCamera.run(
          deviceId,
          ch,
          cameraName,
          gId,
          `ch${ch}, ${name}`,
          mainStream,
          subStream
        );
      }
    }

    res.json({
      success: true,
      deviceId,
      channelsGenerated: finalCount,
      autoDetected: !!channelsToCreate,
      message: `NVR berhasil disimpan! Terdeteksi ${finalCount} channel kamera dengan nama asli bawaan NVR.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/devices/:id/sync-channels - Re-scan & synchronize native camera names from NVR
router.post('/:id/sync-channels', authMiddleware, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!device) {
    return res.status(404).json({ success: false, error: 'Device NVR tidak ditemukan.' });
  }

  try {
    const scanRes = await hikvision.scanNvrChannels(device);
    if (!scanRes.success || scanRes.channels.length === 0) {
      return res.status(400).json({ success: false, error: 'Gagal memindai channel dari NVR. Pastikan NVR online dan username/password sesuai.' });
    }

    const updateCamName = db.prepare(`
      UPDATE cameras
      SET custom_name = ?, tags = ?
      WHERE device_id = ? AND channel_no = ?
    `);

    const insertCam = db.prepare(`
      INSERT INTO cameras (device_id, channel_no, custom_name, group_id, tags, main_stream_url, sub_stream_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let updatedCount = 0;
    for (const ch of scanRes.channels) {
      const existing = db.prepare('SELECT id FROM cameras WHERE device_id = ? AND channel_no = ?').get(id, ch.channelNo);
      if (existing) {
        updateCamName.run(ch.name, `ch${ch.channelNo}, ${ch.model || ''}, ${device.name}`, id, ch.channelNo);
        updatedCount++;
      } else {
        const { mainStream, subStream } = hikvision.generateRTSPUrls(device, ch.channelNo);
        insertCam.run(id, ch.channelNo, ch.name, device.group_id, `ch${ch.channelNo}, ${ch.model || ''}, ${device.name}`, mainStream, subStream);
        updatedCount++;
      }
    }

    db.prepare("UPDATE devices SET channel_count = ?, status = 'online', last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(scanRes.channels.length, id);

    res.json({
      success: true,
      channelsCount: scanRes.channels.length,
      message: `Berhasil menyinkronkan ${updatedCount} channel kamera dengan nama asli bawaan NVR!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/devices/:id
router.get('/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const device = db.prepare(`
    SELECT d.*, g.name AS group_name
    FROM devices d
    LEFT JOIN groups g ON g.id = d.group_id
    WHERE d.id = ?
  `).get(id);

  if (!device) {
    return res.status(404).json({ success: false, error: 'Device NVR tidak ditemukan.' });
  }

  const cameras = db.prepare('SELECT * FROM cameras WHERE device_id = ? ORDER BY channel_no ASC').all(id);
  res.json({ success: true, device, cameras });
});

// PUT /api/devices/:id (Admin only)
router.put('/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, group_id, ip, http_port, rtsp_port, username, password } = req.body;

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!device) {
    return res.status(404).json({ success: false, error: 'Device NVR tidak ditemukan.' });
  }

  const newName = name ? name.trim() : device.name;
  const newIp = ip ? ip.trim() : device.ip;
  const newHPort = http_port ? parseInt(http_port, 10) : device.http_port;
  const newRPort = rtsp_port ? parseInt(rtsp_port, 10) : device.rtsp_port;
  const newUsername = username ? username.trim() : device.username;
  const newPassword = password ? password.trim() : device.password;
  const newGroupId = group_id !== undefined ? (group_id ? parseInt(group_id, 10) : null) : device.group_id;
  const newSerial = req.body.serial_number !== undefined ? (req.body.serial_number ? req.body.serial_number.trim() : null) : device.serial_number;

  db.prepare(`
    UPDATE devices
    SET name = ?, group_id = ?, ip = ?, http_port = ?, rtsp_port = ?, username = ?, password = ?, serial_number = ?
    WHERE id = ?
  `).run(newName, newGroupId, newIp, newHPort, newRPort, newUsername, newPassword, newSerial, id);

  // Update stream URLs on all cameras belonging to this device
  const updatedDevice = {
    ip: newIp,
    rtsp_port: newRPort,
    username: newUsername,
    password: newPassword
  };

  const cameras = db.prepare('SELECT id, channel_no FROM cameras WHERE device_id = ?').all(id);
  const updateCam = db.prepare('UPDATE cameras SET main_stream_url = ?, sub_stream_url = ?, group_id = ? WHERE id = ?');
  for (const cam of cameras) {
    const urls = hikvision.generateRTSPUrls(updatedDevice, cam.channel_no);
    updateCam.run(urls.mainStream, urls.subStream, newGroupId, cam.id);
  }

  res.json({ success: true, message: 'Data NVR dan URL stream berhasil diperbarui.' });
});

// DELETE /api/devices/:id (Admin only)
router.delete('/:id', authMiddleware, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM cameras WHERE device_id = ?').run(id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  res.json({ success: true, message: 'NVR dan semua kameranya berhasil dihapus.' });
});

module.exports = router;

