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
  const v = { d, t, n: S(r[3]), p: S(r[1]).trim(), a: Math.max(Math.abs(num(r[4])), Math.abs(num(r[5]))), r: "" };
  if (r.some((c) => /\bcancel+ed\b|\(cancel/i.test(S(c)))) v.c = 1;
  out.push(v); }); return out; }
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
// ---------------- Tally XML (same rules as the upload page) ----------------
function decodeXml(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let t;
  if (b[0] === 0xff && b[1] === 0xfe) t = b.slice(2).toString("utf16le");
  else if (b[0] === 0xfe && b[1] === 0xff) { const sw = Buffer.from(b.slice(2)); sw.swap16(); t = sw.toString("utf16le"); }
  else if (b.length > 1 && b[1] === 0 && b[0] !== 0) t = b.toString("utf16le");
  else t = b.toString("utf8");
  return t.replace(/^\uFEFF/, "").replace(/&#(?:[0-8]|1[124-9]|2[0-9]|3[01]);/g, " ").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}
const kids = (el) => { const out = []; const c = el.childNodes || []; for (let i = 0; i < c.length; i++) if (c[i].nodeType === 1) out.push(c[i]); return out; };
const first = (el, tag) => (el ? el.getElementsByTagName(tag)[0] : null);
const xt = (el, tag) => { const x = first(el, tag); return x ? String(x.textContent || "").trim() : ""; };
const all = (el, tag) => Array.prototype.slice.call(el.getElementsByTagName(tag));
// direct-child text only (so a voucher's own MASTERID, not a nested one)
const own = (el, tag) => { const k = kids(el).find((c) => c.nodeName === tag); return k ? String(k.textContent || "").trim() : ""; };

function voucherFromEl(v, anyEW) {
  const party = xt(v, "PARTYLEDGERNAME") || xt(v, "PARTYNAME");
  let amt = 0, best = 0;
  const les = all(v, "ALLLEDGERENTRIES.LIST").concat(all(v, "LEDGERENTRIES.LIST"));
  const le = [];
  les.forEach((x) => {
    const name = own(x, "LEDGERNAME"), raw = num(own(x, "AMOUNT")), a = Math.abs(raw);
    if (party && name === party) amt = a; if (a > best) best = a;
    if (name && le.length < 10) le.push({ l: name.slice(0, 50), a: Math.round(raw * 100) / 100 });
  });
  const items = all(v, "ALLINVENTORYENTRIES.LIST").concat(all(v, "INVENTORYENTRIES.LIST")).slice(0, 30)
    .map((ie) => { const qt = xt(ie, "BILLEDQTY") || xt(ie, "ACTUALQTY");
      // o = 1 when Tally marks the line as outward / consumed (ISDEEMEDPOSITIVE = Yes). Used for Stock / Manufacturing Journals.
      return { i: xt(ie, "STOCKITEMNAME"), q: num(qt), a: Math.abs(num(xt(ie, "AMOUNT"))), u: ((qt.match(/[A-Za-z][A-Za-z.]*/) || [""])[0] || "").slice(0, 12), o: /^yes$/i.test(xt(ie, "ISDEEMEDPOSITIVE")) ? 1 : 0 }; });
  const o = { d: tdate(own(v, "DATE") || xt(v, "DATE")), t: (v.getAttribute && v.getAttribute("VCHTYPE")) || xt(v, "VOUCHERTYPENAME"), n: own(v, "VOUCHERNUMBER") || xt(v, "VOUCHERNUMBER"),
    p: party, a: amt || best, r: xt(v, "NARRATION").slice(0, 160), _xml: 1 };
  if (items.length) o.i = items;
  if (le.length) o.le = le;
  const mid = own(v, "MASTERID"), alt = own(v, "ALTERID"); if (mid) o.m = mid; if (alt) o.al = alt;
  if (/^yes$/i.test(own(v, "ISCANCELLED")) || /^yes$/i.test(own(v, "ISDELETED"))) o.c = 1;
  if (/^yes$/i.test(own(v, "ISOPTIONAL"))) o.o = 1;
  const bank = all(v, "BANKALLOCATIONS.LIST");
  const ch = bank.map((b) => xt(b, "INSTRUMENTNUMBER")).filter(Boolean);
  if (ch.length) { o.ch = ch.join(","); o.chd = tdate(xt(bank[0], "INSTRUMENTDATE")); o.tt = xt(bank[0], "TRANSACTIONTYPE"); }
  if (anyEW) { const ew = all(v, "EWAYBILLDETAILS.LIST").map((e) => xt(e, "BILLNUMBER")).filter(Boolean); o.ew = ew.join(","); }
  const irn = xt(v, "IRNACKNO") || xt(v, "IRN"); if (irn) o.irn = irn;
  return o;
}
function parseXmlBuffer(buf, fname) {
  const { DOMParser } = require("@xmldom/xmldom");
  let x;
  try { x = new DOMParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw new Error(e); } } }).parseFromString(decodeXml(buf), "text/xml"); }
  catch (e) { return { error: "not valid XML" }; }
  if (!x || !x.documentElement) return { error: "not valid XML" };
  const has = (t) => x.getElementsByTagName(t).length > 0;
  const name = String(fname || "");
  if (has("VOUCHER")) {
    const anyEW = has("EWAYBILLDETAILS.LIST");
    const data = all(x, "VOUCHER").map((v) => voucherFromEl(v, anyEW)).filter((v) => v.d && /^\d{4}-\d{2}-\d{2}$/.test(v.d));
    return { kind: "vouchers", data };
  }
  const root = x.documentElement;
  if (has("BILLFIXED")) {
    const rows = []; let cur = null;
    kids(root).forEach((el) => { const t = el.nodeName;
      if (t === "BILLFIXED") { cur = { date: tdate(xt(el, "BILLDATE")), ref: xt(el, "BILLREF"), party: xt(el, "BILLPARTY"), amt: 0, due: "", over: 0 }; rows.push(cur); }
      else if (cur && t === "BILLCL") cur.amt = Math.abs(num(el.textContent));
      else if (cur && t === "BILLDUE") cur.due = tdate(el.textContent);
      else if (cur && t === "BILLOVERDUE") cur.over = num(el.textContent); });
    const td = new Date(todayIST() + "T00:00:00Z");
    rows.forEach((r) => { if (!r.over && /^\d{4}/.test(r.date || "")) r.over = Math.max(0, Math.round((td - new Date(r.date + "T00:00:00Z")) / 864e5)); });
    return { kind: /pay|creditor/i.test(name) ? "pay" : "recv", data: rows.filter((r) => r.party || r.ref) };
  }
  if (has("DSPSTKINFO") || has("DSPCLQTY")) {
    const rows = []; let cur = null;
    kids(root).forEach((el) => { if (el.nodeName === "DSPACCNAME") { cur = { item: xt(el, "DSPDISPNAME") || String(el.textContent).trim(), qty: 0, unit: "", rate: 0, val: 0 }; rows.push(cur); }
      else if (el.nodeName === "DSPSTKINFO" && cur) { const q = xt(el, "DSPCLQTY"); cur.qty = num(q); cur.unit = (q.match(/[A-Za-z]+/) || [""])[0]; cur.rate = num(xt(el, "DSPCLRATE")); cur.val = Math.abs(num(xt(el, "DSPCLAMTA") || xt(el, "DSPCLAMT"))); } });
    return { kind: "stock", data: rows.filter((r) => r.item) };
  }
  if (has("DSPACCNAME")) {
    const rows = []; let cur = null;
    kids(root).forEach((el) => { if (el.nodeName === "DSPACCNAME") { cur = { name: xt(el, "DSPDISPNAME") || String(el.textContent).trim(), dr: 0, cr: 0 }; rows.push(cur); }
      else if (el.nodeName === "DSPACCINFO" && cur) { cur.dr = Math.abs(num(xt(el, "DSPCLDRAMTA") || xt(el, "DSPCLDRAMT"))); cur.cr = Math.abs(num(xt(el, "DSPCLCRAMTA") || xt(el, "DSPCLCRAMT"))); } });
    return { kind: "tb", data: rows.filter((r) => r.name) };
  }
  return { error: "not recognised" };
}
module.exports = { parseExcel, parseXmlBuffer, voucherFromEl, todayIST };
