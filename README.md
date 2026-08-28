# Gabung, Seragamkan A4 & Kompres PDF — Versi JavaScript Murni

Versi ini **tidak butuh server/backend sama sekali**. Semua proses (render
PDF, penyeragaman ke A4, kompresi, penggabungan) berjalan langsung di
peramban (browser) pengguna memakai JavaScript. Cocok untuk di-hosting
gratis selamanya di **GitHub Pages**, persis seperti situs KUA Ambulu yang
lain.

## Kenapa ditulis ulang dari versi Flask/Python?

Semua platform hosting Python gratis (Render, Railway, Koyeb, Fly.io,
Hugging Face Spaces) di pertengahan 2026 sudah mempersempit atau menutup
tier gratisnya — sebagian minta kartu kredit, sebagian membatasi CPU sangat
ketat. Dengan memindahkan seluruh proses ke browser, aplikasi ini:

- **Gratis selamanya**, tidak ada batas CPU/kartu kredit/cold-start.
- **Lebih privat** — dokumen (termasuk data pernikahan/berkas resmi) tidak
  pernah meninggalkan komputer pengguna atau diunggah ke server mana pun.
- Bisa langsung digabung ke repo GitHub Pages yang sudah ada.

## Struktur proyek

```
.
├── index.html   # antarmuka pengguna
└── app.js       # seluruh logika (render PDF, kompresi, unduh)
```

Tidak ada `package.json`, tidak ada langkah build — `app.js` memuat
library (`pdfjs-dist` dan `jsPDF`) langsung dari CDN jsDelivr lewat
`import` ES Module.

## Menjalankan di komputer sendiri

Karena pakai ES Module (`type="module"`), file **tidak bisa** dibuka
langsung lewat `file://` — browser akan memblokirnya (kebijakan CORS
modul). Jalankan server statis sederhana dulu, misalnya:

```bash
python3 -m http.server 8000
# atau: npx serve
```

Lalu buka `http://localhost:8000`.

## Deploy ke GitHub Pages

```bash
git init
git add .
git commit -m "Versi JavaScript murni - PDF merger & kompresor"
git branch -M main
git remote add origin https://github.com/<username>/<nama-repo>.git
git push -u origin main
```

Lalu di repo GitHub:
1. Buka **Settings** → **Pages**.
2. Pada **Source**, pilih branch `main` dan folder `/ (root)`.
3. Klik **Save**. Setelah 1-2 menit, situs aktif di
   `https://<username>.github.io/<nama-repo>/`.

Setiap `git push` berikutnya otomatis memperbarui situs.

## Catatan teknis penting (soal QR/TTE)

Bug "QR/TTE hilang" pada versi Python disebabkan library `pypdfium2` yang
tidak diberi tahu untuk menggambar widget form (stempel TTE biasanya
berupa form-field widget). Library `pdf.js` yang dipakai di versi
JavaScript ini punya masalah yang **persis sama**: secara default
(`annotationMode: ENABLE_FORMS`) ia justru **mengecualikan** widget form
dari hasil render ke kanvas. Ini sudah diuji langsung dan dikonfirmasi.

Perbaikannya ada di `app.js`, fungsi `renderPageToA4Canvas` — dipaksa
memakai `annotationMode: pdfjsLib.AnnotationMode.ENABLE` (bukan default
`ENABLE_FORMS`) agar widget QR/TTE ikut tergambar. **Jangan ubah baris
ini** kalau suatu saat meng-upgrade versi `pdfjs-dist`, kecuali sudah
diuji ulang bahwa QR/TTE tetap muncul.

## Batasan dibanding versi server

- Untuk dokumen sangat besar/berlembar sangat banyak, kecepatan tergantung
  perangkat pengguna (terutama di HP kelas bawah), karena semua proses
  jalan di perangkat itu sendiri — bukan lagi di server.
- Perlu koneksi internet saat pertama membuka halaman (untuk memuat
  library dari CDN). Setelah dimuat, proses PDF sendiri tidak butuh
  internet lagi.
- Mengubah pengaturan kompresi tidak memerlukan proses ulang dari server —
  semuanya instan di sisi pengguna.
