// ============================================================================
// PDF Merger & Kompresor - 100% berjalan di browser (tanpa server/backend)
// ============================================================================
//
// Menggantikan versi Flask/Python. Logikanya sengaja dibuat semirip mungkin
// dengan versi Python supaya perilakunya konsisten:
//   - Setiap halaman dirender ke kanvas berukuran seragam A4
//   - Lalu dikompres sebagai JPEG dengan kualitas yang bisa diatur
//   - QR Code/stempel TTE dijaga agar tetap ikut tergambar (lihat catatan
//     PENTING soal `annotationMode` di bawah)
//
// Library dari CDN (tidak perlu build step, langsung jalan di GitHub Pages):
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { jsPDF } from "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm";

const PDFJS_VERSION = "4.10.38";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

const MIN_SAFE_QUALITY = 30;
const DEFAULT_QUALITY = 60;
const DEFAULT_DPI = 150;

// ---------------------------------------------------------------------------
// Rendering PDF -> kanvas A4
// ---------------------------------------------------------------------------

function a4CanvasSize(dpi) {
  // A4 = 8.27 x 11.69 inci
  return [Math.round(8.27 * dpi), Math.round(11.69 * dpi)];
}

async function loadPdf(arrayBuffer) {
  return pdfjsLib.getDocument({
    data: arrayBuffer,
    // Aset pendukung agar font standar & gambar terkompresi (JBIG2/JPX,
    // umum pada dokumen hasil scan) dapat dirender dengan benar.
    cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`,
    wasmUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/wasm/`,
  }).promise;
}

async function renderPageToA4Canvas(page, dpi) {
  const scale = dpi / 72; // unit dasar PDF = 1/72 inci, sama seperti pypdfium2
  const viewport = page.getViewport({ scale });

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = Math.ceil(viewport.width);
  srcCanvas.height = Math.ceil(viewport.height);
  const srcCtx = srcCanvas.getContext('2d', { alpha: false });

  // ------------------------------------------------------------------
  // PENTING — perbaikan bug "QR/TTE hilang" versi JavaScript:
  //
  // pdf.js secara DEFAULT memakai annotationMode = ENABLE_FORMS, yang
  // justru MENGECUALIKAN widget form (termasuk stempel TTE yang di PDF
  // Kemenag umumnya berupa form-field widget) dari hasil render ke
  // kanvas — persis bug yang sama seperti pypdfium2 di versi Python
  // sebelum diperbaiki. Sudah diverifikasi lewat pengujian langsung:
  // dengan ENABLE_FORMS widget tidak tergambar sama sekali, dengan
  // ENABLE ia tergambar penuh. Karena itu di sini WAJIB pakai ENABLE.
  // ------------------------------------------------------------------
  await page.render({
    canvasContext: srcCtx,
    viewport,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
  }).promise;

  const [A4_WIDTH, A4_HEIGHT] = a4CanvasSize(dpi);
  const outCanvas = document.createElement('canvas');
  outCanvas.width = A4_WIDTH;
  outCanvas.height = A4_HEIGHT;
  const outCtx = outCanvas.getContext('2d', { alpha: false });

  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, A4_WIDTH, A4_HEIGHT);

  const ratio = Math.min(A4_WIDTH / srcCanvas.width, A4_HEIGHT / srcCanvas.height);
  const newW = Math.max(1, Math.round(srcCanvas.width * ratio));
  const newH = Math.max(1, Math.round(srcCanvas.height * ratio));
  const tx = Math.floor((A4_WIDTH - newW) / 2);
  const ty = Math.floor((A4_HEIGHT - newH) / 2);

  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, tx, ty, newW, newH);

  return outCanvas;
}

function canvasToJpegDataUrl(canvas, quality) {
  return canvas.toDataURL('image/jpeg', quality / 100);
}

function dataUrlByteSize(dataUrl) {
  // Perkiraan ukuran byte dari base64 data URL (tanpa perlu decode penuh).
  const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
  const padding = (base64.endsWith('==')) ? 2 : (base64.endsWith('=') ? 1 : 0);
  return Math.floor((base64.length * 3) / 4) - padding;
}

// ---------------------------------------------------------------------------
// Pencarian kualitas untuk target ukuran (mirip versi Python)
// ---------------------------------------------------------------------------

function encodeAllPages(canvases, quality) {
  return canvases.map((c) => canvasToJpegDataUrl(c, quality));
}

function totalSizeOf(dataUrls) {
  return dataUrls.reduce((sum, u) => sum + dataUrlByteSize(u), 0);
}

function findQualityForTarget(canvases, targetKb, minQuality = MIN_SAFE_QUALITY) {
  const targetBytes = targetKb * 1024;
  let bestDataUrls = null;
  let bestQuality = minQuality;

  for (let q = 90; q >= minQuality; q -= 5) {
    const dataUrls = encodeAllPages(canvases, q);
    bestDataUrls = dataUrls;
    bestQuality = q;
    if (totalSizeOf(dataUrls) <= targetBytes) {
      return { dataUrls, quality: q, hitTarget: true };
    }
  }
  return { dataUrls: bestDataUrls, quality: bestQuality, hitTarget: false };
}

// ---------------------------------------------------------------------------
// Membangun PDF akhir dari kanvas-kanvas yang sudah dikompres
// ---------------------------------------------------------------------------

function buildPdfBlob(dataUrls) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: false });
  dataUrls.forEach((dataUrl, i) => {
    if (i > 0) doc.addPage('a4', 'p');
    doc.addImage(dataUrl, 'JPEG', 0, 0, 210, 297);
  });
  return doc.output('blob');
}

// ---------------------------------------------------------------------------
// Util: hitung total halaman semua file tanpa merender (cepat, untuk pratinjau)
// ---------------------------------------------------------------------------

async function countTotalPages(files) {
  let total = 0;
  for (const file of files) {
    const buf = await file.arrayBuffer();
    const doc = await loadPdf(buf);
    total += doc.numPages;
    doc.destroy();
  }
  return total;
}

// ============================================================================
// UI wiring
// ============================================================================

const fileInput = document.getElementById('file-input');
const fileListElement = document.getElementById('file-list');
const processBtn = document.getElementById('process-btn');
const previewBtn = document.getElementById('preview-btn');
const statusDiv = document.getElementById('status');
const previewResultDiv = document.getElementById('preview-result');
const dropZone = document.getElementById('drop-zone');
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

let selectedFiles = [];
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

// ---- File handling ----
fileInput.addEventListener('change', handleFiles);
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#2563eb'; });
dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.style.borderColor = '#cbd5e1'; });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = '#cbd5e1';
  if (e.dataTransfer.files.length) {
    const newFiles = Array.from(e.dataTransfer.files).filter((f) => f.type === 'application/pdf');
    selectedFiles = selectedFiles.concat(newFiles);
    updateFileList();
  }
});

function handleFiles() {
  const newFiles = Array.from(fileInput.files).filter((f) => f.type === 'application/pdf');
  selectedFiles = selectedFiles.concat(newFiles);
  fileInput.value = '';
  updateFileList();
}

window.moveFile = function (index, direction) {
  const newIndex = index + direction;
  if (newIndex >= 0 && newIndex < selectedFiles.length) {
    [selectedFiles[index], selectedFiles[newIndex]] = [selectedFiles[newIndex], selectedFiles[index]];
    updateFileList();
  }
};

window.removeFile = function (index) {
  selectedFiles.splice(index, 1);
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
  processBtn.disabled = !hasFiles;
  previewBtn.disabled = !hasFiles;
  clearPreviewResult();
  statusDiv.innerHTML = hasFiles
    ? `Total Dokumen: ${selectedFiles.length} | Estimasi Awal: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`
    : '';
}

function setProgress(pct) {
  if (pct === null) {
    progressWrap.classList.remove('show');
    return;
  }
  progressWrap.classList.add('show');
  progressBar.style.width = `${pct}%`;
}

// ---- Pratinjau ukuran (hanya render 1 halaman sampel, cepat) ----
previewBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;

  previewBtn.disabled = true;
  previewBtn.textContent = 'Menghitung estimasi...';
  previewResultDiv.innerHTML = '';

  try {
    const { quality, dpi, targetKb } = currentSettings();

    const totalPages = await countTotalPages(selectedFiles);
    if (totalPages === 0) throw new Error('Dokumen tidak memiliki halaman.');

    const firstBuf = await selectedFiles[0].arrayBuffer();
    const firstDoc = await loadPdf(firstBuf);
    const samplePage = await firstDoc.getPage(1);
    const sampleCanvas = await renderPageToA4Canvas(samplePage, dpi);
    firstDoc.destroy();

    let usedQuality = quality;
    let hitTarget = true;
    let sampleBytes;

    if (targetKb) {
      const perPageTarget = Math.max(1, Math.floor(targetKb / totalPages));
      const result = findQualityForTarget([sampleCanvas], perPageTarget);
      usedQuality = result.quality;
      hitTarget = result.hitTarget;
      sampleBytes = dataUrlByteSize(result.dataUrls[0]);
    } else {
      sampleBytes = dataUrlByteSize(canvasToJpegDataUrl(sampleCanvas, quality));
    }

    const estimatedTotalKb = Math.round(((sampleBytes * totalPages) / 1024) * 10) / 10;
    const mb = (estimatedTotalKb / 1024).toFixed(2);

    let msg = `📏 Estimasi ukuran akhir: <b>${mb} MB</b> (${totalPages} halaman) — kualitas ${usedQuality}, ${dpi} DPI`;
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

// ---- Proses & unduh (render semua halaman, lalu bangun PDF akhir) ----
processBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;

  processBtn.disabled = true;
  previewBtn.disabled = true;
  processBtn.textContent = 'Sedang Meratakan & Mengompres...';
  statusDiv.innerHTML = 'Mohon tunggu, merender halaman ke A4 langsung di peramban Anda...';
  statusDiv.style.color = '#b45309';
  setProgress(0);

  try {
    const { quality, dpi, targetKb } = currentSettings();

    // Hitung total halaman dulu untuk progress bar yang akurat
    let totalPages = 0;
    const docsMeta = [];
    for (const file of selectedFiles) {
      const buf = await file.arrayBuffer();
      docsMeta.push(buf);
    }
    const pageCanvases = [];
    let renderedSoFar = 0;

    // Hitung total halaman lebih dulu (murah, tanpa render)
    for (const buf of docsMeta) {
      const doc = await loadPdf(buf.slice(0)); // slice(0) = salinan, arrayBuffer bisa "detached" oleh pdf.js
      totalPages += doc.numPages;
      doc.destroy();
    }

    for (const buf of docsMeta) {
      const doc = await loadPdf(buf.slice(0));
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const canvas = await renderPageToA4Canvas(page, dpi);
        pageCanvases.push(canvas);
        renderedSoFar++;
        setProgress(Math.round((renderedSoFar / totalPages) * 70)); // render = 70% progress
      }
      doc.destroy();
    }

    if (pageCanvases.length === 0) throw new Error('Gagal memproses dokumen.');

    statusDiv.innerHTML = 'Mengompres & menyusun PDF akhir...';
    setProgress(80);

    let finalDataUrls, usedQuality, hitTarget;
    if (targetKb) {
      const result = findQualityForTarget(pageCanvases, targetKb);
      finalDataUrls = result.dataUrls;
      usedQuality = result.quality;
      hitTarget = result.hitTarget;
    } else {
      finalDataUrls = encodeAllPages(pageCanvases, quality);
      usedQuality = quality;
      hitTarget = true;
    }

    setProgress(95);
    const pdfBlob = buildPdfBlob(finalDataUrls);
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
