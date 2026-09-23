const db = require('../db');
const hikvision = require('./hikvision');

let broadcastWsFn = null;
let watcherInterval = null;
let isScanning = false;

function setBroadcastFn(fn) {
  broadcastWsFn = fn;
}

function broadcast(data) {
  if (typeof broadcastWsFn === 'function') {
    broadcastWsFn(data);
  }
}

async function runWatchdogCycle() {
  if (isScanning) return;
  isScanning = true;

  try {
    const devices = db.prepare('SELECT * FROM devices').all();

    for (const dev of devices) {
      try {
        // Quick connection test
        const testRes = await hikvision.testConnection({
          ip: dev.ip,
          http_port: dev.http_port || 80,
          username: dev.username,
          password: dev.password
        });

        if (testRes.success) {
          // Device is ONLINE
          // 1. Update status and serial if missing
          const serial = testRes.deviceInfo?.serialNumber || dev.serial_number;
          const model = testRes.deviceInfo?.model || dev.model;

          db.prepare(`
            UPDATE devices
            SET status = 'online', last_seen = CURRENT_TIMESTAMP, serial_number = ?, model = ?
            WHERE id = ?
          `).run(serial, model, dev.id);

          // 2. Auto-sync channel names quickly
          const syncRes = await hikvision.syncDeviceChannelsInDb(dev, db);
          if (syncRes.changed) {
            console.log(`[DeviceWatcher] Auto-synced channel names for ${dev.name} (${syncRes.updatedCount} changes)`);
            broadcast({
              type: 'CHANNELS_UPDATED',
              deviceId: dev.id,
              deviceName: dev.name,
              updatedCount: syncRes.updatedCount
            });
          }
        } else {
          // Device is NOT responding on current IP
          console.warn(`[DeviceWatcher] Device '${dev.name}' (${dev.ip}) is offline. Error: ${testRes.error}`);

          // If device has a serial number, attempt to find its new IP!
          if (dev.serial_number) {
            console.log(`[DeviceWatcher] Searching for '${dev.name}' via Serial Number: ${dev.serial_number}...`);
            const subnets = [
              dev.ip.split('.').slice(0, 3).join('.'),
              '172.16.6',
              '10.1.10',
              '10.1.6',
              '192.168.1'
            ];
            // Remove duplicates
            const uniqueSubnets = [...new Set(subnets)];

            const found = await hikvision.findDeviceBySerial(
              dev.serial_number,
              { username: dev.username, password: dev.password },
              { subnets: uniqueSubnets, httpPort: dev.http_port }
            );

            if (found && found.found && found.ip && found.ip !== dev.ip) {
              const oldIp = dev.ip;
              const newIp = found.ip;
              console.log(`[DeviceWatcher] 🎉 NVR IP CHANGED! Moved from ${oldIp} -> ${newIp}. Updating database automatically...`);

              // Update device IP in DB
              db.prepare(`
                UPDATE devices
                SET ip = ?, status = 'online', last_seen = CURRENT_TIMESTAMP
                WHERE id = ?
              `).run(newIp, dev.id);

              // Update camera RTSP stream URLs in DB
              const updatedDev = { ...dev, ip: newIp };
              const cams = db.prepare('SELECT id, channel_no FROM cameras WHERE device_id = ?').all(dev.id);
              const updateCamStmt = db.prepare('UPDATE cameras SET main_stream_url = ?, sub_stream_url = ? WHERE id = ?');

              for (const cam of cams) {
                const { mainStream, subStream } = hikvision.generateRTSPUrls(updatedDev, cam.channel_no);
                updateCamStmt.run(mainStream, subStream, cam.id);
              }

              broadcast({
                type: 'DEVICE_IP_UPDATED',
                deviceId: dev.id,
                deviceName: dev.name,
                oldIp,
                newIp
              });
            } else {
              db.prepare("UPDATE devices SET status = 'offline' WHERE id = ?").run(dev.id);
            }
          } else {
            db.prepare("UPDATE devices SET status = 'offline' WHERE id = ?").run(dev.id);
          }
        }
      } catch (devErr) {
        console.error(`[DeviceWatcher] Error checking ${dev.name}:`, devErr.message);
      }
    }
  } catch (err) {
    console.error('[DeviceWatcher] Cycle error:', err.message);
  } finally {
    isScanning = false;
  }
}

function startWatcher(intervalMs = 30000) {
  if (watcherInterval) clearInterval(watcherInterval);
  console.log(`[DeviceWatcher] Background watchdog aktif (interval: ${intervalMs / 1000}s)`);
  // Run first cycle after 5 seconds
  setTimeout(runWatchdogCycle, 5000);
  watcherInterval = setInterval(runWatchdogCycle, intervalMs);
}

function stopWatcher() {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}

module.exports = {
  startWatcher,
  stopWatcher,
  setBroadcastFn,
  runWatchdogCycle
};

