const express = require('express');
const router = express.Router();
const fs = require('fs');
const db = require('../db');
const { authMiddleware } = require('../auth');
const downloadManager = require('../services/downloadManager');
const hikvision = require('../services/hikvision');

// POST /api/downloads/search - Search recording clips on NVR
router.post('/search', authMiddleware, async (req, res) => {
  const { deviceId, channelNo, startTime, endTime } = req.body;
  if (!deviceId || !channelNo || !startTime || !endTime) {
    return res.status(400).json({ success: false, error: 'Device, Channel, Start Time, dan End Time wajib diisi.' });
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) {
    return res.status(404).json({ success: false, error: 'Device NVR tidak ditemukan.' });
  }

  try {
    const searchRes = await hikvision.searchRecordings(device, parseInt(channelNo, 10), startTime, endTime);
    res.json(searchRes);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/downloads - Trigger a new video download task
router.post('/', authMiddleware, async (req, res) => {
  const { deviceId, channelNo, startTime, endTime, durationMins, streamType } = req.body;

  if (!deviceId || !channelNo || !startTime) {
    return res.status(400).json({ success: false, error: 'Device, Channel, dan Waktu Mulai (Start Time) wajib diisi.' });
  }

  if (!endTime && !durationMins) {
    return res.status(400).json({ success: false, error: 'Tentukan Waktu Selesai (End Time) atau Durasi dalam Menit.' });
  }

  try {
    const job = await downloadManager.createJob({
      deviceId: parseInt(deviceId, 10),
      channelNo: parseInt(channelNo, 10),
      startTime,
      endTime,
      durationMins: durationMins ? parseInt(durationMins, 10) : null,
      streamType: streamType || 'main',
      user: req.user
    });

    res.json({
      success: true,
      message: 'Proses download rekaman telah dimulai di latar belakang.',
      job
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/downloads - List all download jobs
router.get('/', authMiddleware, (req, res) => {
  const jobs = downloadManager.getJobs(100);
  res.json({ success: true, jobs });
});

// GET /api/downloads/:id - Get specific job status
router.get('/:id', authMiddleware, (req, res) => {
  const job = downloadManager.getJobById(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Tugas download tidak ditemukan.' });
  }
  res.json({ success: true, job });
});

// GET /api/downloads/:id/file - Direct Download MP4 to user's browser/computer
router.get('/:id/file', (req, res) => {
  // Allow downloading file via direct link or token
  const job = downloadManager.getJobById(req.params.id);
  if (!job) {
    return res.status(404).send('File rekaman tidak ditemukan.');
  }

  if (job.status !== 'completed' || !fs.existsSync(job.file_path)) {
    return res.status(400).send('File belum selesai diunduh atau tidak ada di server.');
  }

  res.download(job.file_path, job.file_name, (err) => {
    if (err && !res.headersSent) {
      res.status(500).send('Gagal mengunduh file.');
    }
  });
});

// DELETE /api/downloads/:id - Remove job & file
router.delete('/:id', authMiddleware, (req, res) => {
  const result = downloadManager.deleteJob(req.params.id);
  res.json(result);
});

module.exports = router;

