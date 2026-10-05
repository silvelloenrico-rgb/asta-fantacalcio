// Parsers for the FantaMaster exports. Shared by the browser app and the tests.
const ROLES = ['P', 'D', 'C', 'A'];

function rowsOf(XLSX, ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false, blankrows: true });
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map((c) => String(c ?? '').trim().toLowerCase());
    if (cells.includes('nome') && cells.includes('ruolo')) return { idx: i, cells };
  }
  return null;
}

const col = (cells, ...names) => cells.findIndex((c) => names.includes(c));
const toInt = (v) => { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const roleOf = (v) => { const r = String(v ?? '').trim().toUpperCase().charAt(0); return ROLES.includes(r) ? r : null; };

export function parseRose(XLSX, wb) {
  const teams = [];
  for (const sn of wb.SheetNames) {
    const rows = rowsOf(XLSX, wb.Sheets[sn]);
    let name = sn.replace(/^\s*\d+\s*[.)\-]\s*/, '').trim();
    let credits = 0;
    const title = String((rows[0] || [])[0] ?? '').trim();
    const m = title.match(/^(.*?)\s*\(\s*(-?\d+)[^)]*\)\s*$/);
    if (m) { if (m[1].trim()) name = m[1].trim(); credits = parseInt(m[2], 10); }
    const h = findHeader(rows);
    const players = [];
    if (h) {
      const cN = col(h.cells, 'nome'), cS = col(h.cells, 'squadra', 'club'), cR = col(h.cells, 'ruolo'),
        cC = col(h.cells, 'costo', 'prezzo', 'crediti', 'valore');
      for (let i = h.idx + 1; i < rows.length; i++) {
        const r = rows[i] || [];
        const pn = String(r[cN] ?? '').trim();
        const role = roleOf(r[cR]);
        if (!pn || !role) continue;
        players.push({ name: pn, club: cS >= 0 ? String(r[cS] ?? '').trim() : '', role, cost: cC >= 0 ? toInt(r[cC]) ?? 0 : 0 });
      }
    }
    if (name) teams.push({ name, credits, players });
  }
  return teams;
}

export function parseSvincolati(XLSX, wb) {
  const tutti = wb.SheetNames.find((s) => s.trim().toLowerCase() === 'tutti');
  const sheets = tutti ? [tutti] : wb.SheetNames;
  const out = [];
  const seen = new Set();
  for (const sn of sheets) {
    const rows = rowsOf(XLSX, wb.Sheets[sn]);
    const h = findHeader(rows);
    if (!h) continue;
    const cN = col(h.cells, 'nome'), cS = col(h.cells, 'squadra', 'club'), cR = col(h.cells, 'ruolo'),
      cQ = col(h.cells, 'quotazione', 'quot', 'qt', 'qt.', 'valore', 'prezzo');
    for (let i = h.idx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const name = String(r[cN] ?? '').trim();
      const role = roleOf(r[cR]);
      if (!name || !role) continue;
      const club = cS >= 0 ? String(r[cS] ?? '').trim() : '';
      const key = (name + '|' + club).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, club, role, quotazione: cQ >= 0 ? toInt(r[cQ]) : null });
    }
  }
  return out;
}
