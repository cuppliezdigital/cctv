const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const config = require('./config');

const db = new DatabaseSync(config.DB_PATH);

// Initialize database tables
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      allowed_groups TEXT DEFAULT '*',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      group_id INTEGER,
      ip TEXT NOT NULL,
      http_port INTEGER DEFAULT 80,
      rtsp_port INTEGER DEFAULT 554,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      channel_count INTEGER DEFAULT 16,
      status TEXT DEFAULT 'unknown',
      last_seen DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      channel_no INTEGER NOT NULL,
      custom_name TEXT NOT NULL,
      group_id INTEGER,
      tags TEXT DEFAULT '',
      main_stream_url TEXT,
      sub_stream_url TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS download_jobs (
      id TEXT PRIMARY KEY,
      device_id INTEGER,
      camera_id INTEGER,
      channel_no INTEGER,
      device_name TEXT,
      camera_name TEXT,
      start_time TEXT,
      end_time TEXT,
      duration_mins INTEGER,
      stream_type TEXT DEFAULT 'main',
      status TEXT DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      bytes_downloaded INTEGER DEFAULT 0,
      total_bytes INTEGER DEFAULT 0,
      file_path TEXT,
      file_name TEXT,
      file_size INTEGER DEFAULT 0,
      error_message TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration for devices table: serial_number & model
  try {
    const devTableInfo = db.prepare(`PRAGMA table_info(devices)`).all();
    const colNames = devTableInfo.map(c => c.name);
    if (!colNames.includes('serial_number')) {
      db.exec(`ALTER TABLE devices ADD COLUMN serial_number TEXT;`);
    }
    if (!colNames.includes('model')) {
      db.exec(`ALTER TABLE devices ADD COLUMN model TEXT;`);
    }
  } catch (e) {
    console.error('[DB] Migration error:', e.message);
  }

  try {
    // Seed default groups if empty
    const existingGroups = db.prepare('SELECT id, name FROM groups').all();
    let defaultGroupId = existingGroups.length > 0 ? existingGroups[0].id : null;
    let gudangGroupId = defaultGroupId;
    let parkirGroupId = defaultGroupId;

    if (existingGroups.length === 0) {
      const insertGroup = db.prepare('INSERT INTO groups (name, description) VALUES (?, ?)');
      const g1 = insertGroup.run('Kantor Pusat', 'Gedung utama kantor operasional');
      const g2 = insertGroup.run('Gudang Utama', 'Area logistik dan gudang penyimpanan');
      const g3 = insertGroup.run('Area Parkir & Gerbang', 'Akses luar, gerbang masuk/keluar, dan parkir');
      defaultGroupId = Number(g1.lastInsertRowid);
      gudangGroupId = Number(g2.lastInsertRowid);
      parkirGroupId = Number(g3.lastInsertRowid);
    }

    // Seed default admin if empty
    const adminUser = db.prepare('SELECT * FROM users WHERE username = ?').get(config.DEFAULT_ADMIN.username);
    if (!adminUser) {
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(config.DEFAULT_ADMIN.password, salt);
      const insertUser = db.prepare('INSERT INTO users (username, password_hash, name, role, allowed_groups) VALUES (?, ?, ?, ?, ?)');
      insertUser.run(
        config.DEFAULT_ADMIN.username,
        hash,
        config.DEFAULT_ADMIN.name,
        config.DEFAULT_ADMIN.role,
        '*'
      );
      console.log(`[DB] Default admin created: ${config.DEFAULT_ADMIN.username} / ${config.DEFAULT_ADMIN.password}`);
    }

    // Seed sample demo NVR with 24 channels if devices empty
    const deviceCount = db.prepare('SELECT COUNT(*) as count FROM devices').get().count;
    if (deviceCount === 0) {
      const insertDev = db.prepare(`
        INSERT INTO devices (name, group_id, ip, http_port, rtsp_port, username, password, channel_count, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online')
      `);
      const devRes = insertDev.run('NVR Gudang & Logistik', gudangGroupId || defaultGroupId, '192.168.1.100', 80, 554, 'admin', 'Hik12345', 24);
      const devId = Number(devRes.lastInsertRowid);

      const demoCameraNames = [
        { name: 'Pintu Gerbang Depan', group: parkirGroupId || defaultGroupId, tag: 'gerbang, outdoor, masuk' },
        { name: 'Area Parkir Mobil', group: parkirGroupId || defaultGroupId, tag: 'parkir, depan, mobil' },
        { name: 'Pos Satpam Security', group: parkirGroupId || defaultGroupId, tag: 'pos, satpam, security' },
        { name: 'Lobby & Resepsionis', group: defaultGroupId, tag: 'lobby, resepsionis, tamu' },
        { name: 'Lorong Kantor Lantai 1', group: defaultGroupId, tag: 'kantor, lantai 1, koridor' },
        { name: 'Kasir Utama 01', group: defaultGroupId, tag: 'kasir, transaksi, pembayaran' },
        { name: 'Kasir 02 (Express)', group: defaultGroupId, tag: 'kasir, kasir 2, cepat' },
        { name: 'Ruang Kas & Brankas', group: defaultGroupId, tag: 'kas, brankas, rahasia' },
        { name: 'Ruang Server & Network', group: defaultGroupId, tag: 'server, it, data center' },
        { name: 'Pintu Masuk Gudang', group: gudangGroupId || defaultGroupId, tag: 'gudang, akses, pintu' },
        { name: 'Loading Dock Barat (Truk 1)', group: gudangGroupId || defaultGroupId, tag: 'dock, loading, bongkar, truk' },
        { name: 'Loading Dock Timur (Truk 2)', group: gudangGroupId || defaultGroupId, tag: 'dock, loading, muat, truk' },
        { name: 'Gudang Rak A (Barang Elektronik)', group: gudangGroupId || defaultGroupId, tag: 'gudang, rak a, barang' },
        { name: 'Gudang Rak B (Sparepart)', group: gudangGroupId || defaultGroupId, tag: 'gudang, rak b, sparepart' },
        { name: 'Area Packing & Ekspedisi', group: gudangGroupId || defaultGroupId, tag: 'packing, kirim, kurir' },
        { name: 'Tangga Darurat Barat', group: defaultGroupId, tag: 'tangga, darurat, emergency' },
        { name: 'Ruang Rapat Direksi', group: defaultGroupId, tag: 'meeting, rapat, direksi' },
        { name: 'Pintu Keluar Karyawan', group: defaultGroupId, tag: 'keluar, karyawan, finger' },
        { name: 'Area Parkir Motor', group: parkirGroupId || defaultGroupId, tag: 'parkir, motor, karyawan' },
        { name: 'Gardu Trafo & Generator Genset', group: parkirGroupId || defaultGroupId, tag: 'genset, listrik, trafo' },
        { name: 'Jalur Masuk Truk Kontainer', group: parkirGroupId || defaultGroupId, tag: 'kontainer, logistik, truk' },
        { name: 'Ruang Makan / Pantry', group: defaultGroupId, tag: 'pantry, kantin, istirahat' },
        { name: 'Area Belakang Gudang', group: gudangGroupId || defaultGroupId, tag: 'gudang, belakang, perimeter' },
        { name: 'Pagar Keliling Timur', group: parkirGroupId || defaultGroupId, tag: 'pagar, perimeter, pagar luar' }
      ];

      const insertCam = db.prepare(`
        INSERT INTO cameras (device_id, channel_no, custom_name, group_id, tags, main_stream_url, sub_stream_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      demoCameraNames.forEach((cam, idx) => {
        const ch = idx + 1;
        const main = `rtsp://admin:Hik12345@192.168.1.100:554/Streaming/Channels/${ch}01`;
        const sub = `rtsp://admin:Hik12345@192.168.1.100:554/Streaming/Channels/${ch}02`;
        insertCam.run(devId, ch, cam.name, cam.group, `ch${ch}, ${cam.tag}`, main, sub);
      });

      console.log(`[DB] Seeded demo NVR with 24 channels!`);
    }
  } catch (seedErr) {
    console.warn('[DB] Seeding note (non-critical):', seedErr.message);
  }
}

initDb();

module.exports = db;
