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
    const range = process.env.GOOGLE_SHEET_RANGE || 'A4:M10000';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;

    const sheetRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!sheetRes.ok) {
      const detail = await sheetRes.text();
      return res.status(500).json({ error: 'Gagal ambil data dari Google Sheets', detail });
    }

    const sheetJson = await sheetRes.json();
    const rows = sheetJson.values || [];

    // ---------- MAPPING KOLOM (sesuai urutan kolom sheet PELABUHAN KECIL) ----------
    // BE | Marking | Customer | Description | Ctns | m3 | kgs | 进仓日期 | Total value | Partai | 到港 | 备注
    const records = rows
      .map((row, idx) => ({
        sheet_row_number: idx + 1,
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
        synced_at: new Date().toISOString(),
      }))
      .filter((r) => r.be); // lewati baris yang benar-benar kosong

    if (records.length === 0) {
      return res.status(200).json({ success: true, count: 0, note: 'Tidak ada data ditemukan' });
    }

    // ---------- SIMPAN KE SUPABASE (upsert, biar update kalau sudah ada) ----------
    const { error: upsertError } = await supabaseAdmin
      .from('barang_masuk')
      .upsert(records, { onConflict: 'sheet_row_number' });

    if (upsertError) {
      return res.status(500).json({ error: 'Gagal simpan ke Supabase', detail: upsertError.message });
    }

    return res.status(200).json({ success: true, count: records.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
