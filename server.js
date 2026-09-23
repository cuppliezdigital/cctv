const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const config = require('./src/config');
const db = require('./src/db');
const downloadManager = require('./src/services/downloadManager');
const deviceWatcher = require('./src/services/deviceWatcher');

const authRoutes = require('./src/routes/authRoutes');
const deviceRoutes = require('./src/routes/deviceRoutes');
const cameraRoutes = require('./src/routes/cameraRoutes');
const groupRoutes = require('./src/routes/groupRoutes');
const downloadRoutes = require('./src/routes/downloadRoutes');

const app = express();
const server = http.createServer(app);

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Reverse proxy for go2rtc media engine (/media/* -> http://127.0.0.1:1984/*)
app.use('/media', (req, res) => {
  const targetPath = req.url; // Express strips '/media'
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: 1984,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:1984' }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    res.status(502).send('Media Engine Gateway Error: ' + err.message);
  });
  req.pipe(proxyReq);
});

// Serve frontend static assets
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/cameras', cameraRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/downloads', downloadRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Fallback for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Setup WebSocket Server with custom upgrade router
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (urlObj.pathname.startsWith('/media/')) {
    const targetPath = req.url.replace(/^\/media/, '');
    const proxyHeaders = { ...req.headers };
    proxyHeaders.host = '127.0.0.1:1984';
    if (proxyHeaders.origin) {
      proxyHeaders.origin = 'http://127.0.0.1:1984';
    }

    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: 1984,
      path: targetPath,
      method: 'GET',
      headers: proxyHeaders
    });

    proxyReq.on('response', (proxyRes) => {
      socket.write(
        `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}\r\n` +
        Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n'
      );
      proxyRes.pipe(socket);
    });

    proxyReq.on('upgrade', (proxyRes, upstreamSocket, upstreamHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n'
      );
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
      if (head && head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
    });

    proxyReq.on('error', (err) => {
      console.error('[MediaProxy WS Error]', err.message);
      socket.destroy();
    });

    proxyReq.end();
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({
    type: 'CONNECTED',
    message: 'Terhubung ke server CCTV Hub.'
  }));
});

// Broadcast function to all connected clients
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  });
}

downloadManager.setBroadcaster(broadcast);
deviceWatcher.setBroadcastFn(broadcast);

// WebSocket Heartbeat
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
  deviceWatcher.stopWatcher();
});

// Start Server
server.listen(config.PORT, () => {
  console.log('====================================================');
  console.log('       HIKVISION CCTV CENTRAL HUB & DOWNLOADER      ');
  console.log('====================================================');
  console.log(`Server aktif di: http://localhost:${config.PORT}`);
  console.log(`Default Login  : ${config.DEFAULT_ADMIN.username} / ${config.DEFAULT_ADMIN.password}`);
  console.log('====================================================');

  // Start go2rtc media engine with auto-restart
  const { spawn } = require('child_process');
  const fs = require('fs');
  const go2rtcBin = path.join(__dirname, 'bin', 'go2rtc.exe');
  let go2rtcProcess = null;

  function startGo2rtc() {
    if (!fs.existsSync(go2rtcBin)) return;
    try {
      const configPath = path.join(__dirname, 'go2rtc.yaml');
      go2rtcProcess = spawn(go2rtcBin, ['-c', configPath], { cwd: __dirname });
      console.log('[MediaEngine] go2rtc WebRTC / RTSP Gateway aktif di port 1984');

      go2rtcProcess.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg.includes('ERR') || msg.includes('error')) {
          console.error('[MediaEngine stderr]', msg);
        }
      });
      go2rtcProcess.on('error', (err) => console.error('[MediaEngine] go2rtc error:', err.message));
      go2rtcProcess.on('exit', (code) => {
        console.warn(`[MediaEngine] go2rtc keluar dengan kode ${code}. Memulai ulang dalam 2 detik...`);
        setTimeout(startGo2rtc, 2000);
      });
    } catch (e) {
      console.error('[MediaEngine] Gagal menjalankan go2rtc:', e.message);
    }
  }

  startGo2rtc();
  process.on('exit', () => {
    if (go2rtcProcess) go2rtcProcess.kill();
  });

  // Start background watchdog for NVR auto-discovery & channel sync
  deviceWatcher.startWatcher(30000);
});

