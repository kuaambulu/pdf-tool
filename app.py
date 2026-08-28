import os
import io
import shutil
import tempfile
from flask import Flask, render_template, request, send_file, jsonify
from werkzeug.utils import secure_filename
import pypdfium2 as pdfium
from PIL import Image

app = Flask(__name__)

# Batas ukuran unggahan (penting di hosting gratis seperti Render/Railway yang
# RAM-nya terbatas, ~512MB). Sesuaikan jika paket hosting lebih besar.
app.config['MAX_CONTENT_LENGTH'] = 60 * 1024 * 1024  # 60 MB total per request

# Batas aman agar QR/TTE tetap bisa dipindai walau pengguna memilih kompresi ekstrem
MIN_SAFE_QUALITY = 30
DEFAULT_QUALITY = 60
DEFAULT_DPI = 150


def a4_canvas_size(dpi):
    """Ukuran kanvas A4 (piksel) untuk suatu nilai DPI. A4 = 8.27 x 11.69 inci."""
    return round(8.27 * dpi), round(11.69 * dpi)


def render_pdf_to_a4_images(path, dpi, max_pages=None):
    """
    Render satu file PDF menjadi list gambar PIL berukuran seragam A4.

    PENTING: pdf.init_forms() WAJIB dipanggil sebelum halaman diambil.
    Banyak stempel TTE/QR Kemenag disisipkan sebagai form-field widget
    (bukan gambar biasa di konten halaman), dan PDFium hanya menggambar
    elemen tersebut jika form environment sudah diinisialisasi. Tanpa ini,
    QR/TTE hilang di hasil render walau tampak normal di pembaca PDF lain.
    """
    A4_WIDTH, A4_HEIGHT = a4_canvas_size(dpi)
    scale = dpi / 72.0  # unit kanvas PDFium = 1/72 inci

    images = []
    pdf = pdfium.PdfDocument(path)
    try:
        pdf.init_forms()  # <-- kunci perbaikan QR/TTE yang hilang

        page_count = len(pdf) if max_pages is None else min(max_pages, len(pdf))
        for i in range(page_count):
            page = pdf[i]

            bitmap = page.render(
                scale=scale,
                draw_annots=True,     # stempel/anotasi biasa
                may_draw_forms=True,  # widget form (butuh init_forms di atas)
            )
            pil_img = bitmap.to_pil()

            if pil_img.mode != 'RGB':
                pil_img = pil_img.convert('RGB')

            canvas = Image.new('RGB', (A4_WIDTH, A4_HEIGHT), 'white')
            w, h = pil_img.size
            ratio = min(A4_WIDTH / w, A4_HEIGHT / h)
            new_w, new_h = max(1, int(w * ratio)), max(1, int(h * ratio))
            resized = pil_img.resize((new_w, new_h), Image.Resampling.LANCZOS)

            tx = (A4_WIDTH - new_w) // 2
            ty = (A4_HEIGHT - new_h) // 2
            canvas.paste(resized, (tx, ty))
            images.append(canvas)
    finally:
        pdf.close()

    return images


def encode_pdf(images, quality):
    """Encode list gambar PIL jadi satu file PDF (JPEG per halaman), kembalikan bytes."""
    buf = io.BytesIO()
    images[0].save(
        buf,
        "PDF",
        resolution=100.0,
        save_all=True,
        append_images=images[1:],
        quality=quality,
        optimize=True,
        subsampling=0,  # 4:4:4 - jaga ketajaman tepi (penting untuk pola halus QR)
    )
    return buf.getvalue()


def find_quality_for_target(images, target_kb, min_quality=MIN_SAFE_QUALITY):
    """
    Cari kualitas JPEG tertinggi yang membuat ukuran akhir <= target_kb,
    tanpa turun di bawah min_quality (menjaga QR tetap terbaca).
    Gambar sudah dirender sekali; di sini hanya encode ulang (murah/cepat).
    """
    target_bytes = target_kb * 1024
    best_data, best_quality = None, min_quality

    for q in range(90, min_quality - 1, -5):
        data = encode_pdf(images, q)
        best_data, best_quality = data, q
        if len(data) <= target_bytes:
            return data, q, True  # target tercapai

    return best_data, best_quality, False  # target tak tercapai, pakai kualitas minimum


def collect_uploaded_pdfs(files, upload_dir):
    """Simpan file upload ke folder sementara khusus request ini, kembalikan list path."""
    paths = []
    for file in files:
        if file.filename and file.filename.lower().endswith('.pdf'):
            filename = secure_filename(file.filename) or "file.pdf"
            temp_path = os.path.join(upload_dir, filename)
            base, ext = os.path.splitext(temp_path)
            counter = 1
            while os.path.exists(temp_path):
                temp_path = f"{base}_{counter}{ext}"
                counter += 1
            file.save(temp_path)
            paths.append(temp_path)
    return paths


def parse_common_params(form):
    quality = form.get('quality', type=int)
    dpi = form.get('dpi', type=int) or DEFAULT_DPI
    target_kb = form.get('target_kb', type=int)

    quality = DEFAULT_QUALITY if quality is None else quality
    quality = max(MIN_SAFE_QUALITY, min(95, quality))
    dpi = max(72, min(200, dpi))

    return quality, dpi, target_kb


@app.route('/')
def index():
    return render_template('index.html')


@app.errorhandler(413)
def file_too_large(_e):
    return jsonify({"error": "Total ukuran file terlalu besar untuk server ini (maks 60 MB per proses)."}), 413


@app.route('/preview', methods=['POST'])
def preview_pdf():
    """
    Pratinjau CEPAT: hanya render 1 halaman sampel (bukan seluruh dokumen)
    untuk mengestimasi ukuran akhir, agar pengguna bisa mencoba beberapa
    pengaturan kompresi tanpa menunggu proses penuh setiap kali.
    """
    upload_dir = tempfile.mkdtemp(prefix="pdfprev_")
    try:
        files = request.files.getlist('pdf_files[]')
        if not files:
            return jsonify({"error": "Tidak ada file yang diunggah"}), 400

        quality, dpi, target_kb = parse_common_params(request.form)
        paths = collect_uploaded_pdfs(files, upload_dir)
        if not paths:
            return jsonify({"error": "Gagal memproses dokumen."}), 400

        total_pages = 0
        for p in paths:
            doc = pdfium.PdfDocument(p)
            total_pages += len(doc)
            doc.close()

        if total_pages == 0:
            return jsonify({"error": "Dokumen tidak memiliki halaman."}), 400

        sample_images = render_pdf_to_a4_images(paths[0], dpi, max_pages=1)

        if target_kb:
            per_page_target = max(1, target_kb // total_pages)
            _, quality, hit_target = find_quality_for_target(sample_images, per_page_target)
            sample_bytes = len(encode_pdf(sample_images, quality))
        else:
            sample_bytes = len(encode_pdf(sample_images, quality))
            hit_target = True

        estimated_total_kb = round((sample_bytes * total_pages) / 1024, 1)

        return jsonify({
            "estimated_kb": estimated_total_kb,
            "total_pages": total_pages,
            "quality_used": quality,
            "dpi_used": dpi,
            "target_reached": hit_target,
            "warning_qr": quality < 40,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)


@app.route('/process', methods=['POST'])
def process_pdf():
    input_dir = tempfile.mkdtemp(prefix="pdfjob_in_")
    output_dir = tempfile.mkdtemp(prefix="pdfjob_out_")
    try:
        files = request.files.getlist('pdf_files[]')
        if not files:
            return jsonify({"error": "Tidak ada file yang diunggah"}), 400

        quality, dpi, target_kb = parse_common_params(request.form)
        paths = collect_uploaded_pdfs(files, input_dir)
        if not paths:
            return jsonify({"error": "Gagal memproses dokumen."}), 400

        final_images = []
        for path in paths:
            final_images.extend(render_pdf_to_a4_images(path, dpi))

        if not final_images:
            return jsonify({"error": "Gagal memproses dokumen."}), 400

        if target_kb:
            pdf_bytes, used_quality, hit_target = find_quality_for_target(final_images, target_kb)
        else:
            pdf_bytes = encode_pdf(final_images, quality)
            used_quality, hit_target = quality, True

        output_filename = f"Gabungan_Ringkas_{os.urandom(4).hex()}.pdf"
        output_path = os.path.join(output_dir, output_filename)
        with open(output_path, 'wb') as f:
            f.write(pdf_bytes)

        response = send_file(
            output_path,
            as_attachment=True,
            download_name=output_filename,
            mimetype='application/pdf'
        )
        response.headers['X-Quality-Used'] = str(used_quality)
        response.headers['X-Target-Reached'] = str(hit_target).lower()
        # Bersihkan folder input segera (tidak dibutuhkan lagi setelah render)
        shutil.rmtree(input_dir, ignore_errors=True)
        # Bersihkan folder output setelah response selesai dikirim
        response.call_on_close(lambda: shutil.rmtree(output_dir, ignore_errors=True))
        return response

    except Exception as e:
        shutil.rmtree(input_dir, ignore_errors=True)
        shutil.rmtree(output_dir, ignore_errors=True)
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    # Render/Railway menyuntikkan port lewat variabel lingkungan PORT.
    # debug dimatikan secara default agar aman jika terlewat dijalankan langsung di produksi.
    port = int(os.environ.get('PORT', 5000))
    debug_mode = os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(host='0.0.0.0', port=port, debug=debug_mode)
