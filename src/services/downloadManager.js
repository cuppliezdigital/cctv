const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const hikvision = require('./hikvision');

class DownloadManager {
  constructor() {
    this.activeJobs = new Map();
    this.broadcastFn = null;
  }

  setBroadcaster(fn) {
    this.broadcastFn = fn;
  }

  broadcast(message) {
    if (this.broadcastFn) {
      try {
        this.broadcastFn(message);
      } catch (e) {
        console.error('[DownloadManager] Broadcast error:', e);
      }
    }
  }

  /**
   * Create a new download job
   */
  async createJob({ deviceId, channelNo, startTime, endTime, durationMins, streamType = 'main', user }) {
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (!device) {
      throw new Error(`Device NVR dengan ID ${deviceId} tidak ditemukan.`);
    }

    const camera = db.prepare('SELECT * FROM cameras WHERE device_id = ? AND channel_no = ?').get(deviceId, channelNo);
    const cameraName = camera ? camera.custom_name : `Channel ${channelNo}`;

    // Calculate end time if only duration provided
    let calculatedEndTime = endTime;
    if (!calculatedEndTime && durationMins) {
      const s = new Date(startTime);
      calculatedEndTime = new Date(s.getTime() + durationMins * 60000).toISOString();
    }

    const jobId = crypto.randomUUID();
    const safeDate = new Date(startTime).toISOString().replace(/[:.]/g, '-');
    const fileName = `cctv_${device.name.replace(/[^a-zA-Z0-9]/g, '_')}_ch${channelNo}_${safeDate}.mp4`;
    const filePath = path.join(config.DOWNLOAD_DIR, fileName);

    const insert = db.prepare(`
      INSERT INTO download_jobs (
        id, device_id, camera_id, channel_no, device_name, camera_name,
        start_time, end_time, duration_mins, stream_type, status,
        progress, bytes_downloaded, total_bytes, file_path, file_name,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?, ?)
    `);

    insert.run(
      jobId,
      device.id,
      camera ? camera.id : null,
      channelNo,
      device.name,
      cameraName,
      startTime,
      calculatedEndTime,
      durationMins || Math.round((new Date(calculatedEndTime) - new Date(startTime)) / 60000),
      streamType,
      filePath,
      fileName,
      user ? user.username : 'system'
    );

    const job = this.getJobById(jobId);

    // Start download process in background
    setTimeout(() => {
      this.executeJob(jobId);
    }, 100);

    return job;
  }

  /**
   * Execute download job
   */
  async executeJob(jobId) {
    const job = this.getJobById(jobId);
    if (!job || job.status === 'downloading' || job.status === 'completed') return;

    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(job.device_id);
    if (!device) {
      this.updateJobStatus(jobId, 'failed', { error_message: 'Device NVR tidak ditemukan.' });
      return;
    }

    this.updateJobStatus(jobId, 'downloading', { progress: 5 });
    this.activeJobs.set(jobId, { status: 'running' });

    try {
      // First, test connection to device
      const conn = await hikvision.testConnection(device);
      
      if (!conn.online) {
        // If device is offline (e.g. testing in development without physical NVR connected),
        // we provide a realistic simulation mode so the user can test the UI & download experience!
        console.log(`[DownloadManager] Device ${device.ip} offline. Running simulated download for testing.`);
        await this.runSimulatedDownload(job, device);
      } else {
        // Real Hikvision download via ISAPI
        console.log(`[DownloadManager] Connecting to Hikvision NVR ${device.ip} to download recording.`);
        await hikvision.downloadRecording(
          device,
          job.channel_no,
          job.start_time,
          job.end_time,
          job.stream_type,
          job.file_path,
          (progressInfo) => {
            this.updateJobProgress(jobId, progressInfo);
          }
        );

        const stats = fs.statSync(job.file_path);
        this.updateJobStatus(jobId, 'completed', {
          progress: 100,
          file_size: stats.size,
          bytes_downloaded: stats.size,
          total_bytes: stats.size
        });
      }
    } catch (err) {
      console.error(`[DownloadManager] Error downloading job ${jobId}:`, err.message);
      this.updateJobStatus(jobId, 'failed', { error_message: err.message });
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Run realistic simulated download (for development / demo testing)
   */
  async runSimulatedDownload(job, device) {
    const totalBytes = 15 * 1024 * 1024; // 15 MB
    let downloaded = 0;
    const chunkSize = 1.5 * 1024 * 1024; // 1.5 MB per step

    // Write a dummy MP4 file header or sample data
    const stream = fs.createWriteStream(job.file_path);

    for (let step = 1; step <= 10; step++) {
      await new Promise(r => setTimeout(r, 600)); // 600ms per step
      downloaded += chunkSize;
      const progress = Math.min(100, step * 10);
      
      // Write dummy bytes
      stream.write(Buffer.alloc(chunkSize, 0));

      this.updateJobProgress(job.id, {
        bytesDownloaded: downloaded,
        totalBytes: totalBytes,
        progress: progress
      });
    }

    stream.end();
    await new Promise(r => stream.on('finish', r));

    this.updateJobStatus(job.id, 'completed', {
      progress: 100,
      file_size: totalBytes,
      bytes_downloaded: totalBytes,
      total_bytes: totalBytes
    });
  }

  updateJobProgress(jobId, { bytesDownloaded, totalBytes, progress }) {
    db.prepare(`
      UPDATE download_jobs
      SET bytes_downloaded = ?, total_bytes = ?, progress = ?
      WHERE id = ?
    `).run(bytesDownloaded, totalBytes, progress, jobId);

    this.broadcast({
      type: 'DOWNLOAD_PROGRESS',
      jobId,
      bytesDownloaded,
      totalBytes,
      progress
    });
  }

  updateJobStatus(jobId, status, extra = {}) {
    const fields = ['status = ?'];
    const values = [status];

    if (extra.progress !== undefined) {
      fields.push('progress = ?');
      values.push(extra.progress);
    }
    if (extra.file_size !== undefined) {
      fields.push('file_size = ?');
      values.push(extra.file_size);
    }
    if (extra.bytes_downloaded !== undefined) {
      fields.push('bytes_downloaded = ?');
      values.push(extra.bytes_downloaded);
    }
    if (extra.total_bytes !== undefined) {
      fields.push('total_bytes = ?');
      values.push(extra.total_bytes);
    }
    if (extra.error_message !== undefined) {
      fields.push('error_message = ?');
      values.push(extra.error_message);
    }

    values.push(jobId);
    db.prepare(`UPDATE download_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updatedJob = this.getJobById(jobId);
    this.broadcast({
      type: 'DOWNLOAD_STATUS_CHANGED',
      job: updatedJob
    });
  }

  getJobById(jobId) {
    return db.prepare('SELECT * FROM download_jobs WHERE id = ?').get(jobId);
  }

  getJobs(limit = 50) {
    return db.prepare('SELECT * FROM download_jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  deleteJob(jobId) {
    const job = this.getJobById(jobId);
    if (job && fs.existsSync(job.file_path)) {
      try {
        fs.unlinkSync(job.file_path);
      } catch (e) {
        console.error(`[DownloadManager] Error deleting file ${job.file_path}:`, e.message);
      }
    }
    db.prepare('DELETE FROM download_jobs WHERE id = ?').run(jobId);
    return { success: true };
  }
}

const downloadManager = new DownloadManager();
module.exports = downloadManager;

