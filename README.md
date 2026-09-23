# CCTV Central Hub (Hikvision VMS & Video Downloader)

Sistem Video Management System (VMS) berbasis web terpusat untuk CCTV & NVR Hikvision. Dirancang khusus untuk memecahkan kendala pengelolaan multi-IP NVR dengan puluhan kamera per device.

## ✨ Fitur Utama

1. **Auto RTSP & Channel Generator**:
   - Cukup masukkan 1 IP NVR (misal 24 atau 32 channel), sistem otomatis membuatkan 24 channel kamera lengkap dengan URL RTSP Main & Sub stream tanpa input satu per satu.
2. **Pengelompokan Lokasi (Grouping)**:
   - Kelompokkan NVR & Kamera per cabang, gudang, lantai, atau zona operasional.
3. **Pencarian Instan (Fast Search)**:
   - Cari kamera secara langsung berdasarkan nama (misal: "Kasir", "Gerbang", "Loading Dock"), nomor channel, IP, atau nama grup lokasi.
4. **Download Video Rekaman Lengkap**:
   - Pilih NVR mana, Channel berapa, Waktu Mulai (Start Time), dan Durasi Menit (5, 10, 15, 30, 60 menit atau kustom).
   - Menggunakan protokol resmi Hikvision ISAPI ContentMgmt untuk mendownload video langsung dari storage NVR ke file `.mp4`.
   - Progress bar real-time via WebSocket dan tombol "Unduh ke PC".
5. **Multi-Akun (Admin vs User)**:
   - **Admin**: Akses penuh ke NVR, grup, kamera, dan kelola user.
   - **User / Operator**: Khusus live view, pencarian kamera, dan unduh rekaman yang diizinkan.
6. **Live View Grid**:
   - Pilihan layout grid `1x1`, `2x2`, `3x3`, dan `4x4` dengan tombol snapshot cepat.

---

## 🚀 Cara Menjalankan

### Opsi 1: Klik Ganda (Paling Mudah)
Cukup double-click file **`start.bat`** di folder ini. Aplikasi akan langsung membuka browser ke `http://localhost:3000`.

### Opsi 2: Menggunakan Terminal
```bash
node server.js
```
Lalu buka browser Anda di: `http://localhost:3000`

---


*(Anda dapat mengganti atau menambah user baru di tab menu **User**).*

---

## 🛠️ Stack Teknologi

- **Backend Runtime**: Node.js v24 (Express.js, WebSockets `ws`)
- **Database**: Embedded SQLite (`node:sqlite`) - Zero setup, tersimpan di `data/cctv.sqlite`
- **Frontend**: Single Page Application (HTML5, Tailwind CSS, FontAwesome)
- **CCTV Integration**: Hikvision ISAPI (HTTP Digest Auth) & RTSP Stream Engine
- **Storage**: Folder `downloads/` untuk menampung file video rekaman MP4

