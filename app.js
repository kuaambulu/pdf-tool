// ============================================================================
// PDF Merger & Kompresor - 100% berjalan di browser (tanpa server/backend)
// v2: perbaikan bug lanskap->potret + pratinjau halaman + editor rotasi +
//     tanda tangan (gambar tangan atau tempel gambar PNG/JPEG)
// ============================================================================
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { jsPDF } from "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm";

const PDFJS_VERSION = "4.10.38";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

const MIN_SAFE_QUALITY = 30;
const DEFAULT_QUALITY = 60;
const DEFAULT_DPI = 150;
const PREVIEW_DPI = 72; // resolusi render untuk kartu pratinjau (cukup tajam, tetap cepat)

// ---------------------------------------------------------------------------
// Ukuran kanvas A4 - potret & lanskap
// ---------------------------------------------------------------------------
function a4Size(dpi, landscape) {
  const w = Math.round(8.27 * dpi);
  const h = Math.round(11.69 * dpi);
  return landscape ? [h, w] : [w, h];
}

async function loadPdf(arrayBuffer) {
  return pdfjsLib.getDocument({
    data: arrayBuffer,
    cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`,
    wasmUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/wasm/`,
  }).promise;
}

/**
 * Render satu halaman PDF ke kanvas A4, dengan orientasi mengikuti bentuk
 * ASLI halaman (potret tetap potret, lanskap tetap lanskap) ditambah rotasi
 * manual dari pengguna (0/90/180/270).
 *
 * PERBAIKAN BUG "lanskap jadi potret": versi sebelumnya selalu memaksa
 * kanvas keluaran berbentuk potret (8.27x11.69) apa pun bentuk halaman
 * sumbernya, sehingga halaman lanskap "diciutkan" ke bingkai potret dan
 * tampak salah. Di sini bentuk kanvas keluaran (potret/lanskap) ditentukan
 * dari hasil `viewport` SETELAH rotasi diterapkan, bukan dipaksa potret.
 *
 * PENTING (lihat juga catatan di README): annotationMode WAJIB `ENABLE`
 * (bukan default `ENABLE_FORMS`) agar widget QR/TTE ikut tergambar.
 */
async function renderPageOriented(page, dpi, userRotationDeg) {
  const totalRotation = (page.rotate + userRotationDeg + 360) % 360;
  const scale = dpi / 72;
  const viewport = page.getViewport({ scale, rotation: totalRotation });

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = Math.ceil(viewport.width);
  srcCanvas.height = Math.ceil(viewport.height);
  const srcCtx = srcCanvas.getContext('2d', { alpha: false });

  await page.render({
    canvasContext: srcCtx,
    viewport,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
  }).promise;

  const landscape = viewport.width > viewport.height;
  const [W, H] = a4Size(dpi, landscape);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = W;
  outCanvas.height = H;
  const outCtx = outCanvas.getContext('2d', { alpha: false });
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, W, H);

  const ratio = Math.min(W / srcCanvas.width, H / srcCanvas.height);
  const newW = Math.max(1, Math.round(srcCanvas.width * ratio));
  const newH = Math.max(1, Math.round(srcCanvas.height * ratio));
  const tx = Math.floor((W - newW) / 2);
  const ty = Math.floor((H - newH) / 2);

  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, tx, ty, newW, newH);

  return { canvas: outCanvas, landscape };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Menggambar semua tanda tangan/stempel ke kanvas target.
 *
 * PERBAIKAN BUG "TTD menyempit di potret / memanjang di lanskap": versi
 * sebelumnya menyimpan lebar & tinggi sebagai dua rasio (wRatio, hRatio)
 * yang MASING-MASING dihitung terhadap lebar dan tinggi kanvas secara
 * independen. Karena rasio lebar:tinggi kanvas A4 berbeda antara potret
 * (210:297) dan lanskap (297:210), kombinasi rasio yang sama menghasilkan
 * bentuk piksel yang berbeda (gepeng) tergantung orientasi halaman.
 *
 * Perbaikannya: ukuran disimpan sebagai `widthMm` (ukuran fisik asli,
 * dalam milimeter kertas A4 — SAMA untuk semua orientasi) dan tinggi
 * diturunkan dari rasio alami gambar (`aspect`), lalu dikonversi ke
 * piksel memakai skala mm->px masing-masing sumbu kanvas. Hasilnya
 * ukuran fisik tanda tangan konsisten apa pun orientasi halamannya.
 */
async function bakeSignatures(canvas, signatures, landscape) {
  if (!signatures || signatures.length === 0) return;
  const { w: pageWmm, h: pageHmm } = pageMm(landscape);
  const ctx = canvas.getContext('2d');
  for (const sig of signatures) {
    const img = await loadImage(sig.dataUrl);
    const widthPx = (sig.widthMm / pageWmm) * canvas.width;
    const heightMm = sig.widthMm * sig.aspect;
    const heightPx = (heightMm / pageHmm) * canvas.height;
    const x = sig.xRatio * canvas.width;
    const y = sig.yRatio * canvas.height;
    ctx.drawImage(img, x, y, widthPx, heightPx);
  }
}

function canvasToJpegDataUrl(canvas, quality) {
  return canvas.toDataURL('image/jpeg', quality / 100);
}

function dataUrlByteSize(dataUrl) {
  const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
  return Math.floor((base64.length * 3) / 4) - padding;
}

// ---------------------------------------------------------------------------
// Pencarian kualitas untuk target ukuran
// ---------------------------------------------------------------------------
function findQualityForTarget(dataUrlsAtQuality, targetKb, minQuality = MIN_SAFE_QUALITY) {
  // dataUrlsAtQuality: function(quality) => string[] data URL tiap halaman
  const targetBytes = targetKb * 1024;
  let best = null, bestQ = minQuality;
  for (let q = 90; q >= minQuality; q -= 5) {
    const urls = dataUrlsAtQuality(q);
    const total = urls.reduce((s, u) => s + dataUrlByteSize(u), 0);
    best = urls; bestQ = q;
    if (total <= targetBytes) return { dataUrls: urls, quality: q, hitTarget: true };
  }
  return { dataUrls: best, quality: bestQ, hitTarget: false };
}

// ---------------------------------------------------------------------------
// Membangun PDF akhir — tiap halaman mempertahankan orientasinya sendiri
// ---------------------------------------------------------------------------
function buildPdfBlob(pageResults) {
  // pageResults: [{ dataUrl, landscape }]
  const doc = new jsPDF({
    unit: 'mm',
    format: 'a4',
    orientation: pageResults[0].landscape ? 'l' : 'p',
    compress: false,
  });
  // Halaman pertama sudah sesuai orientasi lewat konstruktor jsPDF di atas;
  // untuk halaman berikutnya, tambahkan page baru dengan orientasi masing-masing.
  pageResults.forEach((p, i) => {
    const dims = p.landscape ? [297, 210] : [210, 297];
    if (i > 0) doc.addPage('a4', p.landscape ? 'l' : 'p');
    doc.addImage(p.dataUrl, 'JPEG', 0, 0, dims[0], dims[1]);
  });
  return doc.output('blob');
}

// ============================================================================
// State
// ============================================================================
let selectedFiles = [];
/** docCache[i] = { doc, pageProxies: Map<pageNum, proxy> } selaras selectedFiles */
let docCache = [];
/**
 * pages[]: daftar datar seluruh halaman lintas file, dalam urutan akhir.
 * { fileIndex, pageNumInFile, baseRotation, userRotation, signatures: [...],
 *   previewLandscape }
 */
let pages = [];
let preparedSignatureAsset = null; // { dataUrl, aspect }
let preparedStempelAsset = null;   // { dataUrl, aspect }
let sigIdCounter = 0;
let currentSigColor = '#1e3a8a'; // default: biru tua

/** Ukuran fisik halaman A4 dalam mm, sesuai orientasi. */
function pageMm(landscape) {
  return landscape ? { w: 297, h: 210 } : { w: 210, h: 297 };
}

// ============================================================================
// UI refs
// ============================================================================
const fileInput = document.getElementById('file-input');
const fileListElement = document.getElementById('file-list');
const dropZone = document.getElementById('drop-zone');
const previewPagesBtn = document.getElementById('preview-pages-btn');
const previewPagesStatus = document.getElementById('preview-pages-status');

const step2Container = document.getElementById('step2-container');
const step3Container = document.getElementById('step3-container');
const pageGrid = document.getElementById('page-grid');

const drawSigBtn = document.getElementById('draw-sig-btn');
const uploadSigBtn = document.getElementById('upload-sig-btn');
const sigFileInput = document.getElementById('sig-file-input');
const sigAssetPreview = document.getElementById('sig-asset-preview');
const sigAssetImg = document.getElementById('sig-asset-img');
const clearSigAssetBtn = document.getElementById('clear-sig-asset-btn');

const uploadStempelBtn = document.getElementById('upload-stempel-btn');
const stempelFileInput = document.getElementById('stempel-file-input');
const stempelAssetPreview = document.getElementById('stempel-asset-preview');
const stempelAssetImg = document.getElementById('stempel-asset-img');
const clearStempelAssetBtn = document.getElementById('clear-stempel-asset-btn');

const sigModal = document.getElementById('sig-modal');
const sigPadCanvas = document.getElementById('sig-pad-canvas');
const sigPadClear = document.getElementById('sig-pad-clear');
const sigPadCancel = document.getElementById('sig-pad-cancel');
const sigPadSave = document.getElementById('sig-pad-save');
const sigColorCustom = document.getElementById('sig-color-custom');
const sigColorSwatches = document.querySelectorAll('.color-swatch');

const processBtn = document.getElementById('process-btn');
const previewBtn = document.getElementById('preview-btn');
const statusDiv = document.getElementById('status');
const previewResultDiv = document.getElementById('preview-result');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');

const advancedToggle = document.getElementById('advanced-toggle');
const advancedPanel = document.getElementById('advanced-panel');
const qualitySlider = document.getElementById('quality-slider');
const qualityValue = document.getElementById('quality-value');
const dpiSlider = document.getElementById('dpi-slider');
const dpiValue = document.getElementById('dpi-value');
const targetKbInput = document.getElementById('target-kb');
const qrWarning = document.getElementById('qr-warning');

const PRESETS = {
  ringan: { dpi: 150, quality: 75 },
  sedang: { dpi: 120, quality: 60 },
  kuat: { dpi: 96, quality: 45 },
  ekstrem: { dpi: 72, quality: 30 },
};

// ---------------------------------------------------------------------------
// Langkah 1: pilih & urutkan file
// ---------------------------------------------------------------------------
fileInput.addEventListener('change', handleFiles);
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#2563eb'; });
dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.style.borderColor = '#cbd5e1'; });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = '#cbd5e1';
  if (e.dataTransfer.files.length) {
    const newFiles = Array.from(e.dataTransfer.files).filter((f) => f.type === 'application/pdf');
    selectedFiles = selectedFiles.concat(newFiles);
    invalidatePreview();
    updateFileList();
  }
});

function handleFiles() {
  const newFiles = Array.from(fileInput.files).filter((f) => f.type === 'application/pdf');
  selectedFiles = selectedFiles.concat(newFiles);
  fileInput.value = '';
  invalidatePreview();
  updateFileList();
}

window.moveFile = function (index, direction) {
  const newIndex = index + direction;
  if (newIndex >= 0 && newIndex < selectedFiles.length) {
    [selectedFiles[index], selectedFiles[newIndex]] = [selectedFiles[newIndex], selectedFiles[index]];
    invalidatePreview();
    updateFileList();
  }
};

window.removeFile = function (index) {
  selectedFiles.splice(index, 1);
  invalidatePreview();
  updateFileList();
};

function updateFileList() {
  fileListElement.innerHTML = '';
  let totalSize = 0;

  selectedFiles.forEach((file, index) => {
    totalSize += file.size;
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="file-info"><b>${index + 1}.</b> ${file.name} <span style="color:#64748b; font-size:12px;">(${(file.size / 1024).toFixed(1)} KB)</span></div>
      <div class="file-actions">
        <button onclick="moveFile(${index}, -1)" ${index === 0 ? 'disabled' : ''} title="Naikkan">&#9650;</button>
        <button onclick="moveFile(${index}, 1)" ${index === selectedFiles.length - 1 ? 'disabled' : ''} title="Turunkan">&#9660;</button>
        <button class="btn-delete" onclick="removeFile(${index})" title="Hapus">&#10006;</button>
      </div>
    `;
    fileListElement.appendChild(li);
  });

  const hasFiles = selectedFiles.length > 0;
  previewPagesBtn.disabled = !hasFiles;
  previewPagesStatus.textContent = hasFiles
    ? `Total Dokumen: ${selectedFiles.length} | Estimasi Awal: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`
    : '';
}

function invalidatePreview() {
  pages = [];
  docCache.forEach((d) => d && d.doc && d.doc.destroy());
  docCache = [];
  pageGrid.innerHTML = '';
  step2Container.classList.add('hidden');
  step3Container.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Langkah 2: bangun pratinjau halaman
// ---------------------------------------------------------------------------
previewPagesBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;
  previewPagesBtn.disabled = true;
  previewPagesBtn.textContent = 'Merender pratinjau...';

  try {
    invalidatePreview();
    pageGrid.innerHTML = '';

    for (let fi = 0; fi < selectedFiles.length; fi++) {
      const buf = await selectedFiles[fi].arrayBuffer();
      const doc = await loadPdf(buf);
      docCache[fi] = { doc, pageProxies: new Map() };

      for (let pn = 1; pn <= doc.numPages; pn++) {
        previewPagesStatus.textContent = `Merender pratinjau: file ${fi + 1}/${selectedFiles.length}, halaman ${pn}/${doc.numPages}...`;
        const page = await doc.getPage(pn);
        docCache[fi].pageProxies.set(pn, page);

        const pageEntry = {
          fileIndex: fi,
          pageNumInFile: pn,
          baseRotation: page.rotate,
          userRotation: 0,
          signatures: [],
        };
        pages.push(pageEntry);

        const { canvas, landscape } = await renderPageOriented(page, PREVIEW_DPI, 0);
        pageEntry.previewLandscape = landscape;
        buildPageCard(pageEntry, canvas);
      }
    }

    step2Container.classList.remove('hidden');
    step3Container.classList.remove('hidden');
    previewPagesStatus.textContent = `${pages.length} halaman siap diedit.`;
  } catch (err) {
    console.error(err);
    previewPagesStatus.textContent = `❌ Gagal membuat pratinjau: ${err.message}`;
  } finally {
    previewPagesBtn.disabled = false;
    previewPagesBtn.textContent = '🖼️ Pratinjau & Edit Halaman →';
  }
});

function pageGlobalIndex(pageEntry) {
  return pages.indexOf(pageEntry);
}

function buildPageCard(pageEntry, canvas) {
  const card = document.createElement('div');
  card.className = 'page-card';
  card.dataset.pageIndex = String(pageGlobalIndex(pageEntry));

  const wrap = document.createElement('div');
  wrap.className = 'thumb-wrap';
  wrap.appendChild(canvas);

  const label = document.createElement('div');
  label.className = 'page-label';
  const fileName = selectedFiles[pageEntry.fileIndex].name;
  label.textContent = `${fileName} — hal. ${pageEntry.pageNumInFile}`;

  const rotateRow = document.createElement('div');
  rotateRow.className = 'rotate-row';
  const rotLeftBtn = document.createElement('button');
  rotLeftBtn.type = 'button';
  rotLeftBtn.textContent = '⟲ 90°';
  rotLeftBtn.title = 'Putar kiri 90°';
  const rotRightBtn = document.createElement('button');
  rotRightBtn.type = 'button';
  rotRightBtn.textContent = '⟳ 90°';
  rotRightBtn.title = 'Putar kanan 90°';
  rotateRow.appendChild(rotLeftBtn);
  rotateRow.appendChild(rotRightBtn);

  const placeRow = document.createElement('div');
  placeRow.className = 'place-sig-row';
  const placeTtdBtn = document.createElement('button');
  placeTtdBtn.type = 'button';
  placeTtdBtn.className = 'btn btn-secondary';
  placeTtdBtn.textContent = '📌 TTD';
  const placeStempelBtn = document.createElement('button');
  placeStempelBtn.type = 'button';
  placeStempelBtn.className = 'btn btn-secondary';
  placeStempelBtn.textContent = '📌 Stempel';
  placeRow.appendChild(placeTtdBtn);
  placeRow.appendChild(placeStempelBtn);

  const sizeList = document.createElement('div');
  sizeList.className = 'sig-size-list';

  card.appendChild(wrap);
  card.appendChild(label);
  card.appendChild(rotateRow);
  card.appendChild(placeRow);
  card.appendChild(sizeList);
  pageGrid.appendChild(card);

  async function rerenderThumb(newRotation) {
    pageEntry.userRotation = ((newRotation % 360) + 360) % 360;
    const { canvas: newCanvas, landscape } = await renderPageOriented(
      await getPageProxy(pageEntry.fileIndex, pageEntry.pageNumInFile),
      PREVIEW_DPI,
      pageEntry.userRotation
    );
    pageEntry.previewLandscape = landscape;
    wrap.innerHTML = '';
    wrap.appendChild(newCanvas);
    renderSignatureOverlays(wrap, pageEntry, sizeList);
  }

  rotLeftBtn.addEventListener('click', () => rerenderThumb(pageEntry.userRotation - 90));
  rotRightBtn.addEventListener('click', () => rerenderThumb(pageEntry.userRotation + 90));

  function placeAsset(type) {
    const asset = type === 'ttd' ? preparedSignatureAsset : preparedStempelAsset;
    if (!asset) {
      alert(type === 'ttd'
        ? 'Siapkan tanda tangan dulu: klik "Gambar Tanda Tangan" atau "Unggah Gambar" di panel TTD.'
        : 'Siapkan gambar stempel dulu: klik "Unggah Gambar Stempel (PNG)" di panel Stempel.');
      return;
    }
    pageEntry.signatures.push({
      id: ++sigIdCounter,
      type,
      dataUrl: asset.dataUrl,
      aspect: asset.aspect,
      xRatio: 0.55,
      yRatio: 0.78,
      widthMm: type === 'ttd' ? 40 : 30, // ukuran awal; bisa diubah custom (geser/resize atau input mm)
    });
    renderSignatureOverlays(wrap, pageEntry, sizeList);
  }

  placeTtdBtn.addEventListener('click', () => placeAsset('ttd'));
  placeStempelBtn.addEventListener('click', () => placeAsset('stempel'));

  renderSignatureOverlays(wrap, pageEntry, sizeList);
}

async function getPageProxy(fileIndex, pageNum) {
  const cached = docCache[fileIndex].pageProxies.get(pageNum);
  if (cached) return cached;
  const page = await docCache[fileIndex].doc.getPage(pageNum);
  docCache[fileIndex].pageProxies.set(pageNum, page);
  return page;
}

// ---------------------------------------------------------------------------
// Overlay tanda tangan/stempel: render, geser (drag), ubah ukuran, hapus
// ---------------------------------------------------------------------------

/** Lebar/tinggi overlay dalam persen (%), dihitung dari ukuran fisik (mm)
 *  agar bentuknya selalu benar (tidak gepeng) di orientasi mana pun. */
function overlayGeometryPercent(pageEntry, sig) {
  const { w: pageWmm, h: pageHmm } = pageMm(pageEntry.previewLandscape);
  const widthPercent = (sig.widthMm / pageWmm) * 100;
  const heightMm = sig.widthMm * sig.aspect;
  const heightPercent = (heightMm / pageHmm) * 100;
  return { widthPercent, heightPercent };
}

function renderSignatureOverlays(wrap, pageEntry, sizeList) {
  wrap.querySelectorAll('.sig-overlay').forEach((el) => el.remove());
  if (sizeList) sizeList.innerHTML = '';

  pageEntry.signatures.forEach((sig) => {
    const { widthPercent, heightPercent } = overlayGeometryPercent(pageEntry, sig);

    const overlay = document.createElement('div');
    overlay.className = 'sig-overlay';
    overlay.dataset.sigId = String(sig.id);
    overlay.style.left = `${sig.xRatio * 100}%`;
    overlay.style.top = `${sig.yRatio * 100}%`;
    overlay.style.width = `${widthPercent}%`;
    overlay.style.height = `${heightPercent}%`;

    const img = document.createElement('img');
    img.src = sig.dataUrl;
    overlay.appendChild(img);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'sig-resize-handle';
    overlay.appendChild(resizeHandle);

    const deleteHandle = document.createElement('div');
    deleteHandle.className = 'sig-delete-handle';
    deleteHandle.textContent = '×';
    overlay.appendChild(deleteHandle);

    deleteHandle.addEventListener('pointerdown', (e) => e.stopPropagation());
    deleteHandle.addEventListener('click', (e) => {
      e.stopPropagation();
      pageEntry.signatures = pageEntry.signatures.filter((s) => s.id !== sig.id);
      renderSignatureOverlays(wrap, pageEntry, sizeList);
    });

    // --- Geser (drag posisi) ---
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === resizeHandle || e.target === deleteHandle) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startXRatio = sig.xRatio, startYRatio = sig.yRatio;
      overlay.setPointerCapture(e.pointerId);

      function onMove(ev) {
        const dxRatio = (ev.clientX - startX) / rect.width;
        const dyRatio = (ev.clientY - startY) / rect.height;
        const { widthPercent: wp, heightPercent: hp } = overlayGeometryPercent(pageEntry, sig);
        sig.xRatio = clamp(startXRatio + dxRatio, 0, 1 - wp / 100);
        sig.yRatio = clamp(startYRatio + dyRatio, 0, 1 - hp / 100);
        overlay.style.left = `${sig.xRatio * 100}%`;
        overlay.style.top = `${sig.yRatio * 100}%`;
      }
      function onUp() {
        overlay.releasePointerCapture(e.pointerId);
        overlay.removeEventListener('pointermove', onMove);
        overlay.removeEventListener('pointerup', onUp);
      }
      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerup', onUp);
    });

    // --- Ubah ukuran (seret titik biru; ukuran FISIK dalam mm, rasio gambar terkunci) ---
    resizeHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = wrap.getBoundingClientRect();
      const { w: pageWmm } = pageMm(pageEntry.previewLandscape);
      const mmPerPx = pageWmm / rect.width; // konversi gerak piksel layar -> mm fisik
      const startX = e.clientX;
      const startWidthMm = sig.widthMm;
      resizeHandle.setPointerCapture(e.pointerId);

      function onMove(ev) {
        const dxMm = (ev.clientX - startX) * mmPerPx;
        sig.widthMm = clamp(startWidthMm + dxMm, 10, pageWmm * 0.95);
        const { widthPercent: wp, heightPercent: hp } = overlayGeometryPercent(pageEntry, sig);
        overlay.style.width = `${wp}%`;
        overlay.style.height = `${hp}%`;
        const mmInput = sizeList && sizeList.querySelector(`input[data-sig-id="${sig.id}"]`);
        if (mmInput) mmInput.value = Math.round(sig.widthMm);
      }
      function onUp() {
        resizeHandle.releasePointerCapture(e.pointerId);
        resizeHandle.removeEventListener('pointermove', onMove);
        resizeHandle.removeEventListener('pointerup', onUp);
      }
      resizeHandle.addEventListener('pointermove', onMove);
      resizeHandle.addEventListener('pointerup', onUp);
    });

    wrap.appendChild(overlay);

    // --- Baris kontrol ukuran presisi (mm) di bawah kartu ---
    if (sizeList) {
      const row = document.createElement('div');
      row.className = 'sig-size-row';

      const rowLabel = document.createElement('span');
      rowLabel.className = 'sig-row-label';
      rowLabel.textContent = sig.type === 'stempel' ? '🔖 Stempel' : '✍️ TTD';

      const mmInput = document.createElement('input');
      mmInput.type = 'number';
      mmInput.min = '10';
      mmInput.max = '400';
      mmInput.step = '1';
      mmInput.value = String(Math.round(sig.widthMm));
      mmInput.dataset.sigId = String(sig.id);
      mmInput.title = 'Lebar dalam milimeter (tinggi menyesuaikan otomatis)';

      const mmUnit = document.createElement('span');
      mmUnit.textContent = 'mm';

      const rowDelete = document.createElement('button');
      rowDelete.type = 'button';
      rowDelete.className = 'sig-row-delete';
      rowDelete.textContent = '🗑';
      rowDelete.title = 'Hapus';

      mmInput.addEventListener('input', () => {
        const val = Number(mmInput.value);
        if (!Number.isFinite(val)) return;
        const { w: pageWmm } = pageMm(pageEntry.previewLandscape);
        sig.widthMm = clamp(val, 10, pageWmm * 0.95);
        const { widthPercent: wp, heightPercent: hp } = overlayGeometryPercent(pageEntry, sig);
        const overlayEl = wrap.querySelector(`.sig-overlay[data-sig-id="${sig.id}"]`);
        if (overlayEl) {
          overlayEl.style.width = `${wp}%`;
          overlayEl.style.height = `${hp}%`;
        }
      });

      rowDelete.addEventListener('click', () => {
        pageEntry.signatures = pageEntry.signatures.filter((s) => s.id !== sig.id);
        renderSignatureOverlays(wrap, pageEntry, sizeList);
      });

      row.appendChild(rowLabel);
      row.appendChild(mmInput);
      row.appendChild(mmUnit);
      row.appendChild(rowDelete);
      sizeList.appendChild(row);
    }
  });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------------
// Panel TTD & Stempel: siapkan aset (gambar tangan / unggah gambar)
// ---------------------------------------------------------------------------

/** Memuat gambar untuk mengetahui rasio tinggi:lebar aslinya (dipakai agar
 *  ukuran custom tetap proporsional, tidak gepeng, saat di-resize). */
async function prepareAsset(dataUrl) {
  const img = await loadImage(dataUrl);
  return { dataUrl, aspect: img.naturalHeight / img.naturalWidth };
}

async function setPreparedSignature(dataUrl) {
  preparedSignatureAsset = await prepareAsset(dataUrl);
  sigAssetImg.src = dataUrl;
  sigAssetPreview.classList.remove('hidden');
}

async function setPreparedStempel(dataUrl) {
  preparedStempelAsset = await prepareAsset(dataUrl);
  stempelAssetImg.src = dataUrl;
  stempelAssetPreview.classList.remove('hidden');
}

clearSigAssetBtn.addEventListener('click', () => {
  preparedSignatureAsset = null;
  sigAssetPreview.classList.add('hidden');
});

clearStempelAssetBtn.addEventListener('click', () => {
  preparedStempelAsset = null;
  stempelAssetPreview.classList.add('hidden');
});

uploadSigBtn.addEventListener('click', () => sigFileInput.click());
sigFileInput.addEventListener('change', () => {
  const file = sigFileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => setPreparedSignature(reader.result);
  reader.readAsDataURL(file);
  sigFileInput.value = '';
});

uploadStempelBtn.addEventListener('click', () => stempelFileInput.click());
stempelFileInput.addEventListener('change', () => {
  const file = stempelFileInput.files[0];
  if (!file) return;
  if (file.type !== 'image/png') {
    alert('Gambar stempel harus berformat PNG (agar latar belakang transparan).');
    stempelFileInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => setPreparedStempel(reader.result);
  reader.readAsDataURL(file);
  stempelFileInput.value = '';
});

// --- Modal gambar tanda tangan (dengan pilihan warna) ---
let sigPadDrawing = false;
let sigPadCtx = null;

sigColorSwatches.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentSigColor = btn.dataset.color;
    sigColorSwatches.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    sigColorCustom.value = currentSigColor;
    if (sigPadCtx) sigPadCtx.strokeStyle = currentSigColor;
  });
});
sigColorCustom.addEventListener('input', () => {
  currentSigColor = sigColorCustom.value;
  sigColorSwatches.forEach((b) => b.classList.remove('active'));
  if (sigPadCtx) sigPadCtx.strokeStyle = currentSigColor;
});

function setupSigPadCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = sigPadCanvas.getBoundingClientRect();
  sigPadCanvas.width = rect.width * dpr;
  sigPadCanvas.height = rect.height * dpr;
  sigPadCtx = sigPadCanvas.getContext('2d');
  sigPadCtx.scale(dpr, dpr);
  sigPadCtx.lineWidth = 3;
  sigPadCtx.lineCap = 'round';
  sigPadCtx.lineJoin = 'round';
  sigPadCtx.strokeStyle = currentSigColor;
  sigPadCtx.clearRect(0, 0, sigPadCanvas.width, sigPadCanvas.height);
}

function sigPadPos(e) {
  const rect = sigPadCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

drawSigBtn.addEventListener('click', () => {
  sigModal.classList.add('show');
  setupSigPadCanvas();
});
sigPadCancel.addEventListener('click', () => sigModal.classList.remove('show'));
sigPadClear.addEventListener('click', () => {
  sigPadCtx.clearRect(0, 0, sigPadCanvas.width, sigPadCanvas.height);
});
sigPadSave.addEventListener('click', () => {
  setPreparedSignature(sigPadCanvas.toDataURL('image/png'));
  sigModal.classList.remove('show');
});

sigPadCanvas.addEventListener('pointerdown', (e) => {
  sigPadDrawing = true;
  sigPadCanvas.setPointerCapture(e.pointerId);
  const { x, y } = sigPadPos(e);
  sigPadCtx.beginPath();
  sigPadCtx.moveTo(x, y);
});
sigPadCanvas.addEventListener('pointermove', (e) => {
  if (!sigPadDrawing) return;
  const { x, y } = sigPadPos(e);
  sigPadCtx.lineTo(x, y);
  sigPadCtx.stroke();
});
sigPadCanvas.addEventListener('pointerup', () => { sigPadDrawing = false; });
sigPadCanvas.addEventListener('pointerleave', () => { sigPadDrawing = false; });

// ---------------------------------------------------------------------------
// Langkah 3: pengaturan kompresi (preset/lanjutan) — sama seperti sebelumnya
// ---------------------------------------------------------------------------
let advancedMode = false;

document.querySelectorAll('input[name="preset"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const p = PRESETS[radio.value];
    qualitySlider.value = p.quality;
    dpiSlider.value = p.dpi;
    qualityValue.textContent = p.quality;
    dpiValue.textContent = p.dpi;
    updateQrWarning();
    clearPreviewResult();
  });
});

advancedToggle.addEventListener('click', () => {
  advancedMode = !advancedMode;
  advancedPanel.classList.toggle('show', advancedMode);
  advancedToggle.textContent = advancedMode
    ? '⚙️ Pengaturan lanjutan (kualitas / target ukuran kustom) ▴'
    : '⚙️ Pengaturan lanjutan (kualitas / target ukuran kustom) ▾';
});

qualitySlider.addEventListener('input', () => {
  qualityValue.textContent = qualitySlider.value;
  updateQrWarning();
  clearPreviewResult();
});
dpiSlider.addEventListener('input', () => {
  dpiValue.textContent = dpiSlider.value;
  clearPreviewResult();
});
targetKbInput.addEventListener('input', clearPreviewResult);

function updateQrWarning() {
  qrWarning.classList.toggle('show', Number(qualitySlider.value) < 40);
}
function clearPreviewResult() {
  previewResultDiv.innerHTML = '';
}
function currentSettings() {
  return {
    quality: Number(qualitySlider.value),
    dpi: Number(dpiSlider.value),
    targetKb: targetKbInput.value ? Number(targetKbInput.value) : null,
  };
}
function setProgress(pct) {
  if (pct === null) { progressWrap.classList.remove('show'); return; }
  progressWrap.classList.add('show');
  progressBar.style.width = `${pct}%`;
}

// ---- Pratinjau ukuran (sampel 1 halaman, dengan rotasi+tanda tangan aktual) ----
previewBtn.addEventListener('click', async () => {
  if (pages.length === 0) return;
  previewBtn.disabled = true;
  previewBtn.textContent = 'Menghitung estimasi...';
  previewResultDiv.innerHTML = '';

  try {
    const { quality, dpi, targetKb } = currentSettings();
    const samplePageEntry = pages[0];
    const page = await getPageProxy(samplePageEntry.fileIndex, samplePageEntry.pageNumInFile);
    const { canvas, landscape } = await renderPageOriented(page, dpi, samplePageEntry.userRotation);
    await bakeSignatures(canvas, samplePageEntry.signatures, landscape);

    let usedQuality = quality, hitTarget = true, sampleBytes;
    if (targetKb) {
      const perPageTarget = Math.max(1, Math.floor(targetKb / pages.length));
      const result = findQualityForTarget((q) => [canvasToJpegDataUrl(canvas, q)], perPageTarget);
      usedQuality = result.quality;
      hitTarget = result.hitTarget;
      sampleBytes = dataUrlByteSize(result.dataUrls[0]);
    } else {
      sampleBytes = dataUrlByteSize(canvasToJpegDataUrl(canvas, quality));
    }

    const estimatedTotalKb = Math.round(((sampleBytes * pages.length) / 1024) * 10) / 10;
    const mb = (estimatedTotalKb / 1024).toFixed(2);

    let msg = `📏 Estimasi ukuran akhir: <b>${mb} MB</b> (${pages.length} halaman) — kualitas ${usedQuality}, ${dpi} DPI`;
    if (targetKb && !hitTarget) {
      msg += `<br><span style="color:#b45309;">Target ${targetKb} KB tidak tercapai tanpa mengorbankan keterbacaan QR — hasil memakai kualitas minimum aman.</span>`;
    }
    if (usedQuality < 40) {
      msg += `<br><span style="color:#b45309;">⚠️ Kualitas ini berisiko membuat QR Code/TTE sulit dipindai.</span>`;
    }
    previewResultDiv.style.color = '#1e293b';
    previewResultDiv.innerHTML = msg;
  } catch (error) {
    console.error(error);
    previewResultDiv.style.color = 'red';
    previewResultDiv.innerHTML = `❌ ${error.message}`;
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = '🔍 Pratinjau Ukuran';
  }
});

// ---- Proses & unduh ----
processBtn.addEventListener('click', async () => {
  if (pages.length === 0) return;

  processBtn.disabled = true;
  previewBtn.disabled = true;
  processBtn.textContent = 'Sedang Meratakan & Mengompres...';
  statusDiv.innerHTML = 'Mohon tunggu, merender halaman akhir langsung di peramban Anda...';
  statusDiv.style.color = '#b45309';
  setProgress(0);

  try {
    const { quality, dpi, targetKb } = currentSettings();

    // Render semua halaman di resolusi FINAL (dpi dari pengaturan kompresi),
    // dengan rotasi & tanda tangan masing-masing halaman.
    const rendered = []; // { canvas, landscape }
    for (let i = 0; i < pages.length; i++) {
      const entry = pages[i];
      const page = await getPageProxy(entry.fileIndex, entry.pageNumInFile);
      const { canvas, landscape } = await renderPageOriented(page, dpi, entry.userRotation);
      await bakeSignatures(canvas, entry.signatures, landscape);
      rendered.push({ canvas, landscape });
      setProgress(Math.round(((i + 1) / pages.length) * 70));
    }

    statusDiv.innerHTML = 'Mengompres & menyusun PDF akhir...';
    setProgress(80);

    let usedQuality, hitTarget, pageResults;
    if (targetKb) {
      const result = findQualityForTarget(
        (q) => rendered.map((r) => canvasToJpegDataUrl(r.canvas, q)),
        targetKb
      );
      usedQuality = result.quality;
      hitTarget = result.hitTarget;
      pageResults = rendered.map((r, i) => ({ dataUrl: result.dataUrls[i], landscape: r.landscape }));
    } else {
      usedQuality = quality;
      hitTarget = true;
      pageResults = rendered.map((r) => ({ dataUrl: canvasToJpegDataUrl(r.canvas, quality), landscape: r.landscape }));
    }

    setProgress(95);
    const pdfBlob = buildPdfBlob(pageResults);
    setProgress(100);

    const finalSizeMB = (pdfBlob.size / (1024 * 1024)).toFixed(2);
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Dokumen_A4_Ringkas_${Date.now()}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 100);

    let msg = `✅ Sukses! File berhasil diunduh. Ukuran Akhir: ${finalSizeMB} MB (kualitas ${usedQuality})`;
    if (targetKb && !hitTarget) {
      msg += `<br><span style="color:#b45309;">Target ukuran tidak sepenuhnya tercapai demi menjaga QR Code/TTE tetap terbaca.</span>`;
    }
    statusDiv.innerHTML = msg;
    statusDiv.style.color = 'green';
  } catch (error) {
    console.error(error);
    statusDiv.innerHTML = `❌ Terjadi kesalahan: ${error.message}`;
    statusDiv.style.color = 'red';
  } finally {
    processBtn.disabled = false;
    previewBtn.disabled = false;
    processBtn.textContent = 'Proses & Unduh PDF';
    setTimeout(() => setProgress(null), 1500);
  }
});
