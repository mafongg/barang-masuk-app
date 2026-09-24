import { GoogleAuth } from 'google-auth-library';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    // ---------- OTORISASI ----------
    // Boleh dipanggil oleh Vercel Cron (header khusus) ATAU oleh user yang sudah login (bawa token Supabase)
    const isCron = req.headers['x-vercel-cron'] !== undefined;

    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    if (!isCron) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '');
      if (!token) {
        return res.status(401).json({ error: 'Tidak ada token, harus login dulu' });
      }
      const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
      if (userError || !userData?.user) {
        return res.status(401).json({ error: 'Token tidak valid, silakan login ulang' });
      }
    }

    // ---------- AMBIL DATA DARI GOOGLE SHEETS ----------
    const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || '';
    const privateKey = privateKeyRaw.includes('\\n')
      ? privateKeyRaw.replace(/\\n/g, '\n')
      : privateKeyRaw;

    const auth = new GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: privateKey,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token || tokenResponse;

    const sheetId = process.env.GOOGLE_SHEET_ID;
    const range = process.env.GOOGLE_SHEET_RANGE || 'A1:M100000';

    // Satu API call aja yang ambil TEKS dan WARNA sekaligus per cell, biar index-nya
    // dijamin selalu sinkron (sebelumnya pakai 2 call terpisah dan itu bisa geser/salah pasang).
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?ranges=${encodeURIComponent(
      range
    )}&fields=sheets.data.rowData.values(formattedValue,userEnteredFormat.backgroundColor)`;

    const sheetRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!sheetRes.ok) {
      const detail = await sheetRes.text();
      return res.status(500).json({ error: 'Gagal ambil data dari Google Sheets', detail });
    }

    const sheetJson = await sheetRes.json();
    const rowDataRaw = sheetJson.sheets?.[0]?.data?.[0]?.rowData || [];

    function cellText(cell) {
      return cell && cell.formattedValue !== undefined ? cell.formattedValue : null;
    }

    function colorToHex(bg) {
      if (!bg) return null;
      const r = bg.red ?? 1, g = bg.green ?? 1, b = bg.blue ?? 1;
      if (r > 0.97 && g > 0.97 && b > 0.97) return null; // putih/kosong = tidak dihighlight
      const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    // rows: array of array of text (persis posisi kolom A..M), sejajar dengan rowDataRaw
    const rows = rowDataRaw.map((rd) => {
      const cells = rd.values || [];
      return Array.from({ length: 12 }, (_, i) => cellText(cells[i]));
    });

    // ---------- MAPPING KOLOM + KLASIFIKASI TIPE BARIS ----------
    // BE | Marking | Customer | Description | Ctns | m3 | kgs | 进仓日期 | Total value | Partai | 到港 | 备注
    //
    // Sheet ini punya 3 jenis baris:
    // 1. "section"  -> baris judul pemisah section (cuma kolom A ada isinya, sisanya kosong), misal "PELABUHAN BESAR"
    // 2. "header"   -> baris header yang diulang di tengah data (kolom A persis "BE"), misal saat mulai section baru
    // 3. "data"     -> baris barang beneran
    function classifyRow(row) {
      const colA = (row[0] || '').toString().trim();
      const restEmpty = row.slice(1, 12).every((v) => !v || v.toString().trim() === '');
      if (colA && restEmpty) return 'section';
      if (colA.toUpperCase() === 'BE') return 'header';
      if (!colA) return 'empty';
      return 'data';
    }

    const records = rows
      .map((row, idx) => {
        const rowType = classifyRow(row);
        const cells = rowDataRaw[idx]?.values || [];
        return {
          sheet_row_number: idx + 1,
          row_type: rowType,
          be: row[0] || null,
          marking: row[1] || null,
          customer: row[2] || null,
          description: row[3] || null,
          ctns: row[4] || null,
          m3: row[5] || null,
          kgs: row[6] || null,
          tanggal_masuk: row[7] || null,
          total_value: row[8] || null,
          partai: row[9] || null,
          tiba_pelabuhan: row[10] || null,
          catatan: row[11] || null,
          ctns_color: colorToHex(cells[4]?.userEnteredFormat?.backgroundColor),
          m3_color: colorToHex(cells[5]?.userEnteredFormat?.backgroundColor),
          kgs_color: colorToHex(cells[6]?.userEnteredFormat?.backgroundColor),
          synced_at: new Date().toISOString(),
        };
      })
      .filter((r) => r.row_type !== 'empty');

    if (records.length === 0) {
      return res.status(200).json({ success: true, count: 0, note: 'Tidak ada data ditemukan' });
    }

    // ---------- SIMPAN KE SUPABASE ----------
    // Hapus semua data lama dulu, lalu isi ulang dengan data terbaru dari sheet.
    // Ini penting supaya kalau ada baris yang DIHAPUS di Google Sheets, baris itu
    // juga ikut hilang dari aplikasi (bukan cuma nambah/update, tapi mirror persis).
    const { error: deleteError } = await supabaseAdmin
      .from('barang_masuk')
      .delete()
      .not('id', 'is', null);

    if (deleteError) {
      return res.status(500).json({ error: 'Gagal membersihkan data lama', detail: deleteError.message });
    }

    // Insert dalam batch (biar aman kalau datanya banyak)
    const batchSize = 500;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const { error: insertError } = await supabaseAdmin.from('barang_masuk').insert(batch);
      if (insertError) {
        return res.status(500).json({ error: 'Gagal simpan ke Supabase', detail: insertError.message });
      }
    }

    return res.status(200).json({ success: true, count: records.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
