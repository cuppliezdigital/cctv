const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const dgram = require('node:dgram');

/**
 * Format Date to Hikvision ISAPI format: YYYY-MM-DDTHH:mm:ssZ
 * Example: 2026-09-18T08:30:00Z
 */
function formatHikTime(dateInput) {
  if (!dateInput) return '';
  if (typeof dateInput === 'string') {
    const m = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    }
  }
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return dateInput;
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
}

/**
 * Format Date to Hikvision RTSP format: YYYYMMDDTHHmmssZ
 * Example: 20260918T083000Z
 */
function formatHikRtspTime(dateInput) {
  if (!dateInput) return '';
  if (typeof dateInput === 'string') {
    const clean = dateInput.replace(/[-: ]/g, '');
    if (/^\d{8}T\d{6}Z?$/.test(clean)) {
      return clean.endsWith('Z') ? clean : clean + 'Z';
    }
    const m = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`;
    }
  }
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return dateInput;
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * Parse Digest Auth challenge from WWW-Authenticate header
 */
function parseDigestHeader(header) {
  if (!header || !header.startsWith('Digest ')) return null;
  const params = {};
  const matches = header.substring(7).matchAll(/([a-zA-Z0-9_-]+)="?([^",]+)"?/g);
  for (const match of matches) {
    params[match[1]] = match[2];
  }
  return params;
}

/**
 * Calculate Digest Authorization Header
 */
function generateDigestAuthHeader(username, password, method, uri, challenge, nc = '00000001') {
  const realm = challenge.realm || 'IP Camera';
  const nonce = challenge.nonce;
  const qop = challenge.qop;
  const cnonce = crypto.randomBytes(8).toString('hex');

  const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');

  let response;
  if (qop && (qop === 'auth' || qop.includes('auth'))) {
    response = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest('hex');
  } else {
    response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
  }

  let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (challenge.opaque) {
    authHeader += `, opaque="${challenge.opaque}"`;
  }
  if (qop && (qop === 'auth' || qop.includes('auth'))) {
    authHeader += `, qop="auth", nc=${nc}, cnonce="${cnonce}"`;
  }

  return authHeader;
}

/**
 * Send HTTP Request with Digest Auth to Hikvision Device
 */
function makeHikvisionRequest(device, { method = 'GET', path = '/', headers = {}, body = null, responseType = 'text', timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    const port = Number(device.http_port) || 80;
    const protocol = port === 443 ? https : http;
    const isHttps = port === 443;

    const initialOptions = {
      hostname: device.ip,
      port: port,
      path: path,
      method: method,
      timeout: timeout,
      headers: {
        'Accept': '*/*',
        ...headers
      },
      rejectUnauthorized: false
    };

    // First request to get 401 challenge
    const req1 = protocol.request(initialOptions, (res1) => {
      if (res1.statusCode === 401 && res1.headers['www-authenticate']) {
        const challenge = parseDigestHeader(res1.headers['www-authenticate']);
        if (!challenge) {
          return reject(new Error('Format challenge autentikasi Hikvision tidak dikenali.'));
        }

        const authHeader = generateDigestAuthHeader(
          device.username,
          device.password,
          method,
          path,
          challenge
        );

        const authenticatedOptions = {
          ...initialOptions,
          headers: {
            ...initialOptions.headers,
            'Authorization': authHeader
          }
        };

        if (body) {
          authenticatedOptions.headers['Content-Type'] = 'application/xml';
          authenticatedOptions.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req2 = protocol.request(authenticatedOptions, (res2) => {
          if (responseType === 'stream') {
            return resolve(res2);
          }

          let data = '';
          res2.on('data', (chunk) => { data += chunk; });
          res2.on('end', () => {
            resolve({
              statusCode: res2.statusCode,
              headers: res2.headers,
              data: data
            });
          });
        });

        req2.on('error', reject);
        req2.on('timeout', () => {
          req2.destroy();
          reject(new Error(`Timeout (${timeout}ms) saat menghubungi NVR ${device.ip}`));
        });

        if (body) {
          req2.write(body);
        }
        req2.end();
      } else {
        // If already 200 or other status without 401 challenge
        if (responseType === 'stream') {
          return resolve(res1);
        }
        let data = '';
        res1.on('data', (chunk) => { data += chunk; });
        res1.on('end', () => {
          resolve({
            statusCode: res1.statusCode,
            headers: res1.headers,
            data: data
          });
        });
      }
    });

    req1.on('error', reject);
    req1.on('timeout', () => {
      req1.destroy();
      reject(new Error(`Koneksi timeout (${timeout}ms) ke IP ${device.ip}:${port}`));
    });

    if (body) {
      req1.write(body);
    }
    req1.end();
  });
}

/**
 * Test Connection & Get Device Info from Hikvision NVR/DVR
 */
async function testConnection(device) {
  try {
    const res = await makeHikvisionRequest(device, {
      method: 'GET',
      path: '/ISAPI/System/deviceInfo',
      timeout: 5000
    });

    if (res.statusCode === 200) {
      // Parse basic XML tags
      const matchModel = res.data.match(/<model>(.*?)<\/model>/i);
      const matchSerial = res.data.match(/<serialNumber>(.*?)<\/serialNumber>/i);
      const matchFirmware = res.data.match(/<firmwareVersion>(.*?)<\/firmwareVersion>/i);
      const matchDeviceName = res.data.match(/<deviceName>(.*?)<\/deviceName>/i);

      return {
        success: true,
        online: true,
        deviceInfo: {
          model: matchModel ? matchModel[1] : 'Hikvision Device',
          serialNumber: matchSerial ? matchSerial[1] : '-',
          firmwareVersion: matchFirmware ? matchFirmware[1] : '-',
          deviceName: matchDeviceName ? matchDeviceName[1] : device.name
        }
      };
    } else if (res.statusCode === 401) {
      return {
        success: false,
        online: true,
        error: 'Autentikasi gagal: Username atau Password NVR salah.'
      };
    } else {
      return {
        success: false,
        online: true,
        error: `NVR merespon status kode ${res.statusCode}`
      };
    }
  } catch (err) {
    return {
      success: false,
      online: false,
      error: `Gagal terhubung ke IP ${device.ip}:${device.http_port} (${err.message})`
    };
  }
}

/**
 * Auto-detect and scan real channels with native names from Hikvision NVR
 */
async function scanNvrChannels(device) {
  try {
    const res = await makeHikvisionRequest(device, {
      method: 'GET',
      path: '/ISAPI/ContentMgmt/InputProxy/channels',
      timeout: 10000
    });

    const channels = [];
    if (res.statusCode === 200 && res.data) {
      const channelBlocks = res.data.match(/<InputProxyChannel[\s\S]*?<\/InputProxyChannel>/g) || [];
      for (const block of channelBlocks) {
        const idMatch = block.match(/<id>(\d+)<\/id>/i);
        const nameMatch = block.match(/<name>(.*?)<\/name>/i);
        const ipMatch = block.match(/<ipAddress>(.*?)<\/ipAddress>/i);
        const modelMatch = block.match(/<model>(.*?)<\/model>/i);

        if (idMatch) {
          const chNo = parseInt(idMatch[1], 10);
          const rawName = nameMatch ? nameMatch[1].trim() : '';
          // Use native name or fallback to Channel XX
          const camName = rawName || `Kamera ${String(chNo).padStart(2, '0')}`;
          channels.push({
            channelNo: chNo,
            name: camName,
            ip: ipMatch ? ipMatch[1].trim() : '',
            model: modelMatch ? modelMatch[1].trim() : ''
          });
        }
      }
    }

    // If InputProxy didn't return channels, fallback to generic count
    if (channels.length === 0) {
      const count = device.channel_count || 16;
      for (let ch = 1; ch <= count; ch++) {
        channels.push({
          channelNo: ch,
          name: `Kamera ${String(ch).padStart(2, '0')}`,
          ip: device.ip,
          model: 'Hikvision Channel'
        });
      }
    }

    return {
      success: true,
      count: channels.length,
      channels
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      channels: []
    };
  }
}

/**
 * Generate authenticated RTSP Playback URL for a recorded segment
 */
function generatePlaybackRTSPUrl(device, channelNo, startTime, endTime, playbackURI) {
  const encPass = encodeURIComponent(device.password);
  const user = device.username;

  if (playbackURI) {
    // If playbackURI is rtsp://172.16.6.96/Streaming/tracks/101/?...
    if (playbackURI.startsWith('rtsp://')) {
      const port = device.rtsp_port || 554;
      const urlWithoutScheme = playbackURI.slice(7);
      const slashIdx = urlWithoutScheme.indexOf('/');
      if (slashIdx !== -1) {
        const hostPart = urlWithoutScheme.slice(0, slashIdx);
        let pathPart = urlWithoutScheme.slice(slashIdx);

        // Precision seek: Replace starttime in playbackURI with exact requested startTime
        if (startTime) {
          const sRtsp = formatHikRtspTime(startTime);
          if (pathPart.includes('starttime=')) {
            pathPart = pathPart.replace(/starttime=[^&]*/, `starttime=${sRtsp}`);
          } else {
            pathPart += (pathPart.includes('?') ? '&' : '?') + `starttime=${sRtsp}`;
          }
        }

        const hostWithPort = hostPart.includes(':') ? hostPart : `${hostPart}:${port}`;
        return `rtsp://${user}:${encPass}@${hostWithPort}${pathPart}`;
      }
      return playbackURI.replace('rtsp://', `rtsp://${user}:${encPass}@`);
    }
  }

  const startHik = formatHikRtspTime(startTime);
  const endHik = formatHikRtspTime(endTime);
  const port = device.rtsp_port || 554;
  return `rtsp://${user}:${encPass}@${device.ip}:${port}/Streaming/tracks/${channelNo}01/?starttime=${startHik}&endtime=${endHik}`;
}

/**
 * Generate standard Hikvision RTSP URLs for a channel
 */
function generateRTSPUrls(device, channelNo) {
  const encPass = encodeURIComponent(device.password);
  const ip = device.ip;
  const port = device.rtsp_port || 554;
  const user = device.username;

  // Hikvision channel format:
  // Channel 1: 101 (Main), 102 (Sub)
  // Channel 24: 2401 (Main), 2402 (Sub)
  const mainStream = `rtsp://${user}:${encPass}@${ip}:${port}/Streaming/Channels/${channelNo}01`;
  const subStream = `rtsp://${user}:${encPass}@${ip}:${port}/Streaming/Channels/${channelNo}02`;

  return {
    mainStream,
    subStream
  };
}

/**
 * Search recording files/segments from Hikvision NVR
 */
async function searchRecordings(device, channelNo, startTime, endTime) {
  const startHik = formatHikTime(startTime);
  const endHik = formatHikTime(endTime);
  // In Hikvision ISAPI, trackID is typically channelNo * 100 + 1 (e.g. 101 for channel 1)
  const trackId = channelNo * 100 + 1;

  const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
  <searchID>${crypto.randomUUID()}</searchID>
  <trackIDList>
    <trackID>${trackId}</trackID>
  </trackIDList>
  <timeSpanList>
    <timeSpan>
      <startTime>${startHik}</startTime>
      <endTime>${endHik}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>50</maxResults>
  <searchResultPosition>0</searchResultPosition>
</CMSearchDescription>`;

  try {
    const res = await makeHikvisionRequest(device, {
      method: 'POST',
      path: '/ISAPI/ContentMgmt/search',
      body: xmlPayload,
      timeout: 10000
    });

    const matches = [];
    if (res.statusCode === 200) {
      // Parse matchList items
      const searchItemRegex = /<searchMatchItem>([\s\S]*?)<\/searchMatchItem>/g;
      let itemMatch;
      while ((itemMatch = searchItemRegex.exec(res.data)) !== null) {
        const itemXml = itemMatch[1];
        const sTime = itemXml.match(/<startTime>(.*?)<\/startTime>/i);
        const eTime = itemXml.match(/<endTime>(.*?)<\/endTime>/i);
        const pUri = itemXml.match(/<playbackURI>(.*?)<\/playbackURI>/i);
        const fSize = itemXml.match(/<mediaSegmentDescriptor>[\s\S]*?<size>(\d+)<\/size>/i);

        matches.push({
          startTime: sTime ? sTime[1] : null,
          endTime: eTime ? eTime[1] : null,
          playbackURI: pUri ? pUri[1].replace(/&amp;/g, '&') : null,
          sizeBytes: fSize ? parseInt(fSize[1], 10) : 0
        });
      }
    }

    return {
      success: true,
      count: matches.length,
      recordings: matches,
      rawResponse: res.data
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      recordings: []
    };
  }
}

const monthDistributionCache = new Map();

/**
 * Query NVR to get dates with recordings in a given month
 */
async function getMonthlyRecordDistribution(device, channelNo, year, month) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const cacheKey = `${device.id || device.ip}_${channelNo}_${y}_${m}`;
  const cached = monthDistributionCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
    return cached.data;
  }

  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const trackId = channelNo * 100 + 1;
  const days = Array.from({ length: lastDay }, (_, i) => i + 1);
  const recordedDays = [];
  const recordedDates = [];

  // Parallel batches of 6 days at a time to complete in ~2s without overloading NVR sockets
  const chunkSize = 6;
  for (let i = 0; i < days.length; i += chunkSize) {
    const chunk = days.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async (d) => {
      const dayStr = `${y}-${pad(m)}-${pad(d)}`;
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
  <searchID>${crypto.randomUUID()}</searchID>
  <trackIDList>
    <trackID>${trackId}</trackID>
  </trackIDList>
  <timeSpanList>
    <timeSpan>
      <startTime>${dayStr}T00:00:00Z</startTime>
      <endTime>${dayStr}T23:59:59Z</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>1</maxResults>
  <searchResultPosition>0</searchResultPosition>
</CMSearchDescription>`;

      try {
        const res = await makeHikvisionRequest(device, {
          method: 'POST',
          path: '/ISAPI/ContentMgmt/search',
          body: xml,
          timeout: 5000
        });

        if (res.statusCode === 200 && res.data) {
          const total = parseInt(res.data.match(/<totalMatches>(\d+)<\/totalMatches>/)?.[1] || '0', 10);
          const num = parseInt(res.data.match(/<numOfMatches>(\d+)<\/numOfMatches>/)?.[1] || '0', 10);
          if (total > 0 || num > 0) {
            recordedDays.push(d);
            recordedDates.push(dayStr);
          }
        }
      } catch (e) {}
    }));
  }

  recordedDays.sort((a, b) => a - b);
  recordedDates.sort();

  const result = {
    success: true,
    year: y,
    month: m,
    recordedDates,
    recordedDays
  };

  monthDistributionCache.set(cacheKey, { timestamp: Date.now(), data: result });
  return result;
}

/**
 * Download recording file from Hikvision NVR via ISAPI
 */
async function downloadRecording(device, channelNo, startTime, endTime, streamType, destPath, onProgress, customPlaybackURI) {
  const startHik = formatHikRtspTime(startTime);
  const endHik = formatHikRtspTime(endTime);
  const streamId = streamType === 'sub' ? `${channelNo}02` : `${channelNo}01`;

  let playbackURI = customPlaybackURI;
  if (!playbackURI) {
    playbackURI = `rtsp://${device.ip}:${device.rtsp_port || 554}/Streaming/tracks/${streamId}?starttime=${startHik}&amp;endtime=${endHik}`;
  } else {
    playbackURI = playbackURI.replace(/&/g, '&amp;');
  }

  const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<downloadRequest version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <playbackURI>${playbackURI}</playbackURI>
</downloadRequest>`;

  try {
    const streamRes = await makeHikvisionRequest(device, {
      method: 'POST',
      path: '/ISAPI/ContentMgmt/download',
      body: xmlPayload,
      responseType: 'stream',
      timeout: 30000
    });

    if (streamRes.statusCode !== 200) {
      let errBody = '';
      streamRes.on('data', chunk => { errBody += chunk; });
      await new Promise(r => streamRes.on('end', r));
      throw new Error(`NVR download error (HTTP ${streamRes.statusCode}): ${errBody || 'Unknown error'}`);
    }

    const totalBytesHeader = streamRes.headers['content-length'];
    const totalBytes = totalBytesHeader ? parseInt(totalBytesHeader, 10) : 0;
    let bytesDownloaded = 0;

    const fileStream = fs.createWriteStream(destPath);

    return new Promise((resolve, reject) => {
      streamRes.on('data', (chunk) => {
        bytesDownloaded += chunk.length;
        const progressPercent = totalBytes > 0 
          ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
          : 0;

        if (onProgress) {
          onProgress({
            bytesDownloaded,
            totalBytes,
            progress: progressPercent
          });
        }
      });

      streamRes.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve({
          success: true,
          bytesDownloaded,
          filePath: destPath
        });
      });

      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });

      streamRes.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
  } catch (err) {
    throw err;
  }
}

/**
 * Get live snapshot JPEG from Hikvision NVR/camera
 */
async function getSnapshot(device, channelNo) {
  return await makeHikvisionRequest(device, {
    method: 'GET',
    path: `/ISAPI/Streaming/channels/${channelNo}01/picture`,
    responseType: 'stream',
    timeout: 5000
  });
}

/**
 * Discover Hikvision devices via SADP UDP multicast/broadcast
 */
function discoverSadpDevices(timeout = 2000) {
  return new Promise((resolve) => {
    const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const probe = Buffer.from('<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>00000000-0000-0000-0000-000000000001</Uuid><Types>inquiry</Types></Probe>');
    const devices = [];

    client.on('message', (msg, rinfo) => {
      const str = msg.toString();
      const getTag = (t) => {
        const m = str.match(new RegExp('<' + t + '>([^<]+)</' + t + '>'));
        return m ? m[1].trim() : '';
      };
      const dev = {
        ip: getTag('IPv4Address') || rinfo.address,
        model: getTag('DeviceDescription') || 'Hikvision Device',
        serialNumber: getTag('DeviceSN') || '',
        mac: getTag('MAC') || '',
        httpPort: parseInt(getTag('HttpPort') || '80', 10),
        sdkPort: parseInt(getTag('CommandPort') || '8000', 10)
      };
      if (dev.serialNumber && !devices.some(d => d.serialNumber === dev.serialNumber)) {
        devices.push(dev);
      }
    });

    client.bind(0, () => {
      try {
        client.setBroadcast(true);
        client.send(probe, 0, probe.length, 37020, '239.255.255.250');
        client.send(probe, 0, probe.length, 37020, '255.255.255.255');
      } catch (e) {}
    });

    setTimeout(() => {
      try { client.close(); } catch (e) {}
      resolve(devices);
    }, timeout);
  });
}

/**
 * Locate a device on the network by its Serial Number
 * Uses SADP first, then scans candidate subnets/IPs if needed
 */
async function findDeviceBySerial(serialQuery, credentials = {}, options = {}) {
  if (!serialQuery) return { found: false, error: 'Nomor seri tidak boleh kosong.' };
  const normSerial = serialQuery.trim().toLowerCase();

  // 1. First, check direct IP if provided in options or hint
  if (options.hintIp) {
    try {
      const conn = await testConnection({
        ip: options.hintIp,
        http_port: options.httpPort || 80,
        username: credentials.username || 'admin',
        password: credentials.password || ''
      });
      if (conn.success && conn.deviceInfo && conn.deviceInfo.serialNumber.toLowerCase().includes(normSerial)) {
        return {
          found: true,
          source: 'hint_ip',
          ip: options.hintIp,
          http_port: options.httpPort || 80,
          rtsp_port: 554,
          model: conn.deviceInfo.model,
          serialNumber: conn.deviceInfo.serialNumber,
          deviceName: conn.deviceInfo.deviceName
        };
      }
    } catch (e) {}
  }

  // 2. SADP Broadcast/Multicast Probe
  try {
    const sadpList = await discoverSadpDevices(1500);
    const match = sadpList.find(d => d.serialNumber && d.serialNumber.toLowerCase().includes(normSerial));
    if (match) {
      return {
        found: true,
        source: 'sadp',
        ip: match.ip,
        http_port: match.httpPort || 80,
        rtsp_port: 554,
        model: match.model,
        serialNumber: match.serialNumber,
        mac: match.mac
      };
    }
  } catch (err) {
    console.warn('[Discovery] SADP error:', err.message);
  }

  // 3. Subnet IP Scanner (for cross-subnet / routed warehouse networks)
  const subnets = options.subnets || ['172.16.6', '10.1.10', '10.1.6', '192.168.1'];
  const user = credentials.username || 'admin';
  const pass = credentials.password || '';

  for (const subnet of subnets) {
    const ips = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${subnet}.${i}`);
    }

    for (let b = 0; b < ips.length; b += 40) {
      const batch = ips.slice(b, b + 40);
      const checks = await Promise.all(batch.map(ip => {
        return new Promise((resolve) => {
          const req = http.request({
            hostname: ip,
            port: options.httpPort || 80,
            path: '/ISAPI/System/deviceInfo',
            method: 'GET',
            timeout: 1000
          }, async (res) => {
            if (res.statusCode === 401 || res.statusCode === 200) {
              try {
                const conn = await testConnection({
                  ip,
                  http_port: options.httpPort || 80,
                  username: user,
                  password: pass
                });
                if (conn.success && conn.deviceInfo && conn.deviceInfo.serialNumber.toLowerCase().includes(normSerial)) {
                  return resolve({
                    found: true,
                    ip,
                    http_port: options.httpPort || 80,
                    rtsp_port: 554,
                    model: conn.deviceInfo.model,
                    serialNumber: conn.deviceInfo.serialNumber,
                    deviceName: conn.deviceInfo.deviceName
                  });
                }
              } catch (e) {}
            }
            resolve(null);
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
      }));

      const found = checks.find(c => c && c.found);
      if (found) return found;
    }
  }

  return {
    found: false,
    error: `Perangkat dengan Nomor Seri '${serialQuery}' tidak ditemukan di jaringan.`
  };
}

/**
 * Synchronize channel names in local database with physical NVR
 */
async function syncDeviceChannelsInDb(device, db) {
  try {
    const scanRes = await scanNvrChannels(device);
    if (!scanRes.success || !scanRes.channels || scanRes.channels.length === 0) {
      return { changed: false, error: scanRes.error || 'Gagal membaca channel dari NVR' };
    }

    const existingCameras = db.prepare('SELECT * FROM cameras WHERE device_id = ?').all(device.id);
    let changed = false;
    let updatedCount = 0;

    const updateNameStmt = db.prepare('UPDATE cameras SET custom_name = ?, main_stream_url = ?, sub_stream_url = ? WHERE id = ?');
    const insertCamStmt = db.prepare(`
      INSERT INTO cameras (device_id, channel_no, custom_name, group_id, tags, main_stream_url, sub_stream_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const ch of scanRes.channels) {
      const match = existingCameras.find(c => c.channel_no === ch.channelNo);
      const { mainStream, subStream } = generateRTSPUrls(device, ch.channelNo);

      if (match) {
        if (match.custom_name !== ch.name || match.main_stream_url !== mainStream) {
          updateNameStmt.run(ch.name, mainStream, subStream, match.id);
          changed = true;
          updatedCount++;
        }
      } else {
        insertCamStmt.run(
          device.id,
          ch.channelNo,
          ch.name,
          device.group_id,
          `ch${ch.channelNo}, ${ch.model || ''}, ${device.name}`,
          mainStream,
          subStream
        );
        changed = true;
        updatedCount++;
      }
    }

    return { changed, updatedCount, totalChannels: scanRes.channels.length };
  } catch (err) {
    return { changed: false, error: err.message };
  }
}

module.exports = {
  formatHikTime,
  formatHikRtspTime,
  makeHikvisionRequest,
  testConnection,
  generateRTSPUrls,
  generatePlaybackRTSPUrl,
  scanNvrChannels,
  searchRecordings,
  getMonthlyRecordDistribution,
  downloadRecording,
  getSnapshot,
  discoverSadpDevices,
  findDeviceBySerial,
  syncDeviceChannelsInDb
};

