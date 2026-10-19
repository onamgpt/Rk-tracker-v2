// Every 2 h: read invoice PDFs that Maadhu emails (subject contains "invoice"), take the carton count,
// and match each invoice to its order (by order number, else by customer name).
// Unloaded order → carton count and invoice number set automatically, labels ready to print.
// Already-loading order → count NOT changed; a mismatch is flagged instead.
const crypto = require("crypto");
const G = require("./gmail.js");
const C = require("./csd-lib.js");
const D = require("./dispatch.js");
const P = require("./purchase-lib.js");
const FROM = "onammadhu@gmail.com";
const toks = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(" ").filter((x) => x.length > 2 && !/^(ltd|pvt|the|and|kerala|india|road|near)$/.test(x));
const orderKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function readInvoices(pdfs) {
  const shape = '{"invoices":[{"invoiceNo":"2026-27/173","date":"2026-05-27","orderNo":"POMBOO93/02244/26-27","customer":"MASTER BHANDAR RTC-3 CRPF KANNUR","cartons":14,"amount":71981.78}]}';
  const prompt = "These are invoices from Onam Agarbathi Pvt. Ltd. (incense) to CSD depots or other buyers. For EACH invoice in the file(s) return:\n" +
    "invoiceNo, date (YYYY-MM-DD), orderNo (the buyer's order / PO number, if shown), customer (buyer or consignee name), cartons (the total number of master cartons / packages / cases in this invoice — if only per-item carton counts are shown, add them up), amount.\n" +
    "Return ONLY JSON in this shape (example values): " + shape + "\nIf a value is not shown, use an empty string or 0.";
  const r = await C.claudePdfs(pdfs, prompt, "Return ONLY valid JSON. Count cartons exactly.");
  return (r.invoices || []).filter((x) => x && x.invoiceNo);
}

// Find the order an invoice belongs to.
function matchShipment(inv, ships) {
  const ok = orderKey(inv.orderNo);
  if (ok.length >= 6) {
    const s = ships.find((x) => x.orderNo && orderKey(x.orderNo) === ok) || ships.find((x) => x.orderNo && (orderKey(x.orderNo).indexOf(ok) >= 0 || ok.indexOf(orderKey(x.orderNo)) >= 0));
    if (s) return { s, how: "order no." };
  }
  const it = toks(inv.customer); if (it.length < 2) return null;
  let best = null, score = 0;
  ships.forEach((x) => { const st = toks(x.customer); if (st.length < 2) return;
    const hit = it.filter((t) => st.indexOf(t) >= 0).length, f = hit / Math.max(it.length, 1);
    if (hit >= 2 && f >= 0.6 && f > score) { score = f; best = x; } });
  return best ? { s: best, how: "customer name" } : null;
}

async function run(opt) {
  opt = opt || {};
  const st = (await D.kvGet("dispatch_inv_state")) || { seen: [], log: [] };
  const invs = (await D.kvGet("dispatch_invoices")) || [];
  const ships = await D.shipments();
  const loads = await D.loadLoads();
  const today = D.todayIST();
  const log = { at: new Date().toISOString(), read: 0, matched: [], unmatched: [], mismatch: [], errors: [] };
  const q = "from:" + FROM + " has:attachment subject:invoice newer_than:" + (st.first ? 30 : 10) + "d";
  const { tok, messages } = await G.search(q, 20);
  for (const m of messages.reverse()) {
    if (st.seen.indexOf(m.id) >= 0) continue;
    const pdfs = (m.attachments || []).filter((a) => /\.pdf$/i.test(a.name));
    if (!pdfs.length) { st.seen.push(m.id); continue; }
    try {
      const bufs = []; for (const a of pdfs.slice(0, 6)) bufs.push(await G.attachment(tok, m.id, a.id));
      const found = await readInvoices(bufs);
      for (const inv of found) {
        if (invs.some((x) => x.invoiceNo === inv.invoiceNo)) continue;
        log.read++;
        const hit = matchShipment(inv, ships);
        const rec = Object.assign({}, inv, { mailId: m.id, subject: m.subject, got: today, orderId: hit ? hit.s.id : null, how: hit ? hit.how : "" });
        if (!hit) { log.unmatched.push(inv.invoiceNo + " · " + (inv.customer || "") + " · " + inv.cartons + " ctn"); invs.unshift(rec); continue; }
        let L = loads.find((x) => x.orderId === hit.s.id);
        if (!L) { L = { id: "dl_" + Date.now().toString(36), orderId: hit.s.id, token: crypto.randomBytes(10).toString("base64url"), loaded: [], created: today, orderNo: hit.s.orderNo || "", customer: hit.s.customer || "" }; loads.push(L); }
        if (!L.loaded.length) { L.total = +inv.cartons || 0; L.invoice = inv.invoiceNo; L.invoiceSource = "Maadhu invoice email"; log.matched.push(inv.invoiceNo + " → " + (hit.s.customer || "").slice(0, 40) + " · " + L.total + " ctn"); }
        else if (+inv.cartons !== L.total) log.mismatch.push(inv.invoiceNo + ": invoice says " + inv.cartons + ", loading count is " + L.total + " (already scanning — not changed)");
        else log.matched.push(inv.invoiceNo + " (already loading, count agrees)");
        rec.loadId = L.id; invs.unshift(rec);
      }
      st.seen.push(m.id);
    } catch (e) { log.errors.push("mail " + m.id + ": " + e.message); }
  }
  await D.kvSet("dispatch_loads", loads);
  await D.kvSet("dispatch_invoices", invs.slice(0, 500));
  st.first = false; st.seen = st.seen.slice(-500); st.log = [log].concat(st.log || []).slice(0, 30);
  await D.kvSet("dispatch_inv_state", st);
  if (log.matched.length || log.unmatched.length || log.mismatch.length) {
    const s = await P.settings();
    const lg = (await D.kvGet("logistics_settings")) || {};
    const to = [lg.prakashEmail || "prakashonam@gmail.com", s.ownerEmail].filter(Boolean);
    const L2 = (xs) => xs.map((x) => "<li>" + x.replace(/</g, "&lt;") + "</li>").join("");
    const html = "<div style='font-family:Arial,sans-serif;font-size:15px'><p>Invoices read from Maadhu's email:</p>" +
      (log.matched.length ? "<p><b>Ready for loading</b></p><ul>" + L2(log.matched) + "</ul>" : "") +
      (log.unmatched.length ? "<p><b>Could not match to an order — please check on the Dispatch page</b></p><ul>" + L2(log.unmatched) + "</ul>" : "") +
      (log.mismatch.length ? "<p><b style='color:#b42318'>Carton count differs</b></p><ul>" + L2(log.mismatch) + "</ul>" : "") + "</div>";
    await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to, subject: "Invoices: " + log.matched.length + " ready, " + log.unmatched.length + " to match" + (log.mismatch.length ? ", " + log.mismatch.length + " count differs" : ""), html }) });
  }
  return { read: log.read, matched: log.matched.length, unmatched: log.unmatched.length, mismatch: log.mismatch.length, errors: log.errors };
}
exports.run = run; exports.matchShipment = matchShipment;
exports.handler = async () => { try { return { statusCode: 200, body: JSON.stringify(await run({})) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
