# Gabung, Seragamkan A4 & Kompres PDF

Aplikasi web Flask untuk menggabungkan beberapa PDF, menyeragamkan setiap
halaman ke ukuran A4, lalu mengompresnya — dengan QR Code/stempel TTE tetap
terjaga tergambar dan terbaca.

## Struktur proyek

```
.
├── app.py              # backend Flask (render PDF, kompresi, endpoint /preview & /process)
├── templates/
│   └── index.html      # antarmuka pengguna
├── requirements.txt
├── Procfile             # perintah start untuk hosting (gunicorn)
└── .gitignore
```

## Menjalankan di komputer sendiri

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Buka `http://localhost:5000` di browser.

## Menaruh kode di GitHub

```bash
git init
git add .
git commit -m "Inisialisasi aplikasi PDF merger & kompresor"
git branch -M main
git remote add origin https://github.com/<username>/<nama-repo>.git
git push -u origin main
```

## Deploy agar bisa diakses publik (Render, gratis)

GitHub Pages **tidak bisa** menjalankan backend Python, jadi backend perlu
di-hosting di layanan yang mendukung Python — Render punya paket gratis yang cukup untuk ini.

1. Buka https://render.com → daftar/masuk (bisa langsung pakai akun GitHub).
2. Klik **New +** → **Web Service**.
3. Pilih **Build and deploy from a Git repository**, lalu hubungkan repo GitHub ini.
4. Isi pengaturan:
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app`
   - **Instance Type**: Free
5. Klik **Create Web Service**. Render akan build & menjalankan aplikasi,
   lalu memberi URL publik seperti `https://nama-app.onrender.com`.
6. Setiap kali kamu `git push` ke GitHub, Render otomatis re-deploy versi terbaru.

### Alternatif hosting gratis lain
- **Railway** (railway.app) — alur mirip Render, hubungkan repo GitHub → deploy otomatis.
- **PythonAnywhere** (pythonanywhere.com) — cocok untuk aplikasi Flask kecil, ada paket gratis.

### Catatan penting untuk paket gratis
- Instance gratis biasanya "tidur" setelah tidak diakses beberapa menit, sehingga
  akses pertama setelah lama tidak dipakai bisa terasa lambat (cold start) — ini normal.
- RAM terbatas (±512 MB), karena itu `app.py` sudah membatasi ukuran total unggahan
  ke 60 MB per proses. Jika mengunggah dokumen sangat besar/berlembar banyak dan
  server kehabisan memori, pertimbangkan menurunkan DPI (preset "Kuat"/"Ekstrem")
  atau menaikkan paket hosting.
