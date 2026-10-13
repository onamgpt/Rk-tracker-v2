// Server-side reader for Tally Excel exports (same rules as the /tally/ upload page).
const XLSX = require("xlsx");
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
function tdate(s) { s = String(s || "").trim(); let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return m[1] + "-" + m[2] + "-" + m[3];
  if ((m = s.match(/^(\d{1,2})[-\s\/]([A-Za-z]{3})[A-Za-z]*[-\s\/](\d{2,4})$/))) { let y = +m[3]; if (y < 100) y += 2000; return y + "-" + pad(MON[m[2].toLowerCase()] || 1) + "-" + pad(+m[1]); }
  if ((m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/))) { let y = +m[3]; if (y < 100) y += 2000; return y + "-" + pad(+m[2]) + "-" + pad(+m[1]); }
  return s; }
function num(s) { if (s == null) return 0; const m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 0; }
function dateOf(v) {
  if (v && typeof v.getFullYear === "function" && !isNaN(v.getTime())) { const d = new Date(v.getTime() + 6 * 3600e3); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  if (typeof v === "number" && v > 20000 && v < 80000) { const u = new Date(Math.round((v - 25569) * 864e5)); return u.getUTCFullYear() + "-" + pad(u.getUTCMonth() + 1) + "-" + pad(u.getUTCDate()); }
  return tdate(v == null ? "" : v); }
const S = (c) => (c == null ? "" : String(c));
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
function classify(sheets, fname) {
  let head = ""; sheets.forEach((s) => (s.rows || []).slice(0, 14).forEach((r) => { head += (r || []).map(S).join(" ") + "\n"; }));
  if (/day\s*book/i.test(head)) return "vouchers"; if (/trial\s*balance/i.test(head)) return "tb"; if (/bills\s*payable/i.test(head)) return "pay";
  if (/bills\s*receivable/i.test(head)) return "recv"; if (/stock\s*summary/i.test(head)) return "stock";
  const f = String(fname || "").toLowerCase();
  if (/day.?book/.test(f)) return "vouchers"; if (/trial/.test(f)) return "tb"; if (/pay/.test(f)) return "pay"; if (/recei|debtor/.test(f)) return "recv"; if (/stock/.test(f)) return "stock";
  return null; }
function dayBookRows(rows) { const out = []; rows.forEach((r) => { r = r || []; const d = dateOf(r[0]); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return; const t = S(r[2]).trim(); if (!t) return;
  out.push({ d, t, n: S(r[3]), p: S(r[1]).trim(), a: Math.max(Math.abs(num(r[4])), Math.abs(num(r[5]))), r: "" }); }); return out; }
function tbRows(rows) { const hi = rows.findIndex((r) => (r || []).some((c) => /^debit$/i.test(S(c).trim()))); if (hi < 0) return [];
  const out = []; for (let j = hi + 1; j < rows.length; j++) { const r = rows[j] || [], name = S(r[0]).trim(); if (!name) continue; if (/grand total/i.test(name)) break; out.push({ name, dr: Math.abs(num(r[1])), cr: Math.abs(num(r[2])) }); } return out; }
function billRows(rows) { const hi = rows.findIndex((r) => (r || []).some((c) => /party/i.test(S(c)))); if (hi < 0) return [];
  const td = new Date(todayIST() + "T00:00:00Z"), out = [];
  for (let i = hi + 1; i < rows.length; i++) { const r = rows[i] || [], party = S(r[2]).trim(); if (!party || /total/i.test(party)) continue;
    const d = dateOf(r[0]), due = dateOf(r[4]); let over = num(r[5]);
    if (!over && /^\d{4}-\d{2}-\d{2}$/.test(d)) over = Math.max(0, Math.round((td - new Date(d + "T00:00:00Z")) / 864e5));
    out.push({ date: /^\d{4}/.test(d) ? d : "", ref: S(r[1]), party, amt: Math.abs(num(r[3])), due: /^\d{4}/.test(due) ? due : "", over }); }
  return out; }
function stockRows(rows) { const hi = rows.findIndex((r) => (r || []).some((c) => /closing/i.test(S(c)))); if (hi < 0) return [];
  const sub = rows[hi + 1] || [], idx = (re) => sub.findIndex((c) => re.test(S(c)));
  const q = idx(/qty/i), rt = idx(/rate/i), v = idx(/value|amount/i); if (q < 0 && v < 0) return [];
  const out = []; for (let j = hi + 2; j < rows.length; j++) { const r = rows[j] || [], name = S(r[0]).trim(); if (!name || /total/i.test(name)) continue;
    const qs = S(r[q]); out.push({ item: name, qty: num(qs), unit: (qs.match(/[A-Za-z]+/) || [""])[0], rate: rt >= 0 ? num(r[rt]) : 0, val: v >= 0 ? Math.abs(num(r[v])) : 0 }); }
  return out; }
// buf: Buffer of an .xlsx/.xls/.csv file -> { kind, data } or { error }
function parseExcel(buf, fname) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheets = wb.SheetNames.map((n) => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: false }) }));
  const kind = classify(sheets, fname); if (!kind) return { error: "not recognised" };
  let data = []; sheets.forEach((s) => { data = data.concat(kind === "vouchers" ? dayBookRows(s.rows) : kind === "tb" ? tbRows(s.rows) : kind === "stock" ? stockRows(s.rows) : billRows(s.rows)); });
  return { kind, data };
}
module.exports = { parseExcel, todayIST };
