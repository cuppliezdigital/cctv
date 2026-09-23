const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'hikvision-cctv-secret-key-super-secure-2026',
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'cctv.sqlite'),
  DOWNLOAD_DIR,
  DEFAULT_ADMIN: {
    username: 'admin',
    password: 'admin123',
    role: 'admin',
    name: 'Super Administrator'
  }
};

