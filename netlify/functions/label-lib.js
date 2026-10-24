// Zebra ZD230 labels (100 × 50 mm, 203 dpi) as raw ZPL, and the print-job queue
// (Supabase table label_jobs) that the Mac Mini label agent drains.
// QR contents match what the Gate / Dispatch / Inventory pages already scan:
//   ONAMC:<token>|n|N  carton   ·   ONAMI:<token>  inward package   ·   ONAMG:<token>  worker card
const W = require("./wa-lib.js");

const PW = 799, LL = 400;                  // 100 mm × 50 mm at 8 dots/mm
const z = (s) => String(s == null ? "" : s).replace(/[\^~\\]/g, " ").replace(/\s+/g, " ").trim();
const cut = (s, n) => { s = z(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const head = () => "^XA^CI28^PW" + PW + "^LL" + LL + "^LH0,0";
const qr = (x, y, mag, data) => "^FO" + x + "," + y + "^BQN,2," + mag + "^FDMA," + data + "^FS";
const txt = (x, y, h, s, w, lines) => "^FO" + x + "," + y + "^A0N," + h + "," + h +
  (w ? "^FB" + w + "," + (lines || 1) + ",0,L" : "") + "^FD" + z(s) + "^FS";
const box = (x, y, w, h, t) => "^FO" + x + "," + y + "^GB" + w + "," + h + "," + (t || 3) + "^FS";

function cartonZpl(L, n) {
  return head() +
    qr(18, 40, 7, "ONAMC:" + L.token + "|" + n + "|" + L.total) +
    txt(270, 22, 26, "ONAM AGARBATHI · DISPATCH") +
    txt(270, 58, 38, cut(L.customer, 60), 510, 2) +
    txt(270, 150, 28, cut("Inv " + (L.invoice || "-") + (L.orderNo ? "  ·  Ord " + L.orderNo : ""), 40)) +
    box(270, 196, 510, 120) +
    txt(290, 214, 30, "CARTON") +
    txt(290, 250, 60, n + " / " + L.total) +
    txt(270, 335, 24, cut(L.dest || "", 45)) +
    "^PQ1^XZ";
}
function inwardZpl(l) {
  const qty = (l.orig != null ? l.orig : l.qty);
  return head() +
    qr(18, 40, 7, "ONAMI:" + l.token) +
    txt(270, 22, 26, "ONAM AGARBATHI · INWARD") +
    txt(270, 58, 36, cut(l.item, 60), 510, 2) +
    txt(270, 145, 44, (qty != null && qty !== "" ? qty + " " + (l.unit || "") : "") + "   " + (l.no || 1) + "/" + (l.of || 1)) +
    txt(270, 205, 26, cut(l.supplier || "", 38)) +
    txt(270, 240, 26, cut("Bill " + (l.bill || "-"), 38)) +
    txt(270, 275, 24, cut((l.batch ? "Batch " + l.batch + "  " : "") + (l.expiry ? "Exp " + l.expiry : ""), 40)) +
    txt(270, 335, 24, "Recd: " + (l.recvd || "expected") + "  ·  scan at gate") +
    "^PQ1^XZ";
}
function cardZpl(w) {
  return head() +
    qr(18, 40, 7, "ONAMG:" + w.token) +
    txt(270, 22, 26, "ONAM AGARBATHI PVT LTD") +
    txt(270, 80, 54, cut(w.name, 40), 510, 2) +
    box(270, 220, 510, 3, 3) +
    txt(270, 245, 32, "GATE ATTENDANCE CARD") +
    txt(270, 300, 24, "Scan IN in the morning, OUT in the evening") +
    "^PQ1^XZ";
}
function testZpl(text) {
  return head() + box(10, 10, 779, 380, 4) + txt(40, 60, 44, "ONAM LABEL PRINTER") +
    txt(40, 140, 34, cut(text || "Test print OK", 40)) + qr(560, 170, 6, "ONAM-TEST") + "^PQ1^XZ";
}

// ---- queue ----
async function queue(kind, ref, title, zpls, notify) {
  if (!zpls.length) return null;
  const r = await W.sb("POST", "/rest/v1/label_jobs", [{ kind, ref: ref || null, title: cut(title, 120), n: zpls.length, zpl: zpls.join("\n"), notify: notify || null }],
    { Prefer: "return=representation" });
  return r && r[0];
}
const queueCartons = (L, notify, only) => queue("carton", L.id, (L.customer || "") + " · " + (L.invoice || L.orderNo || ""),
  (only || Array.from({ length: L.total }, (_, i) => i + 1)).map((n) => cartonZpl(L, n)), notify);
const queueInward = (ref, title, lots, notify) => queue("inward", ref, title, lots.map(inwardZpl), notify);
const queueCard = (w, notify) => queue("card", w.id, "ID card · " + w.name, [cardZpl(w)], notify);

module.exports = { cartonZpl, inwardZpl, cardZpl, testZpl, queue, queueCartons, queueInward, queueCard, PW, LL };
