// Reads CSD mail (read-only Gmail): POs from mgrgp2@gmail.com, payment advices from pafa@csdindia.gov.in.
// Triggered by csd-cron (every 2 h, 9 am–7 pm IST) or "Check CSD mail now" on the Tally page.
const C = require("./csd-lib.js");
const G = require("./gmail.js");
const T = require("./tally.js");
const PO_FROM = "mgrgp2@gmail.com", PAY_FROM = "pafa@csdindia.gov.in";
const SITE = "https://rk-tracker-v2.netlify.app";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function mail(to, subject, html) { try { const r = await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to, subject, html }) }); return JSON.parse(r.body || "{}"); } catch (e) { return { ok: false }; } }
const wrap = (h) => "<div style='font-family:Arial,sans-serif;font-size:15px;color:#16181c;max-width:760px'>" + h + "</div>";
const TH = "style='text-align:left;padding:6px 7px;border-bottom:2px solid #ccc;font-size:13px'", TD = "style='padding:6px 7px;border-bottom:1px solid #e5e5e5;font-size:13px'";
const table = (head, rows) => "<table style='border-collapse:collapse;width:100%'><tr>" + head.map((h) => "<th " + TH + ">" + h + "</th>").join("") + "</tr>" + rows.map((r) => "<tr>" + r.map((c) => "<td " + TD + ">" + c + "</td>").join("") + "</tr>").join("") + "</table>";

function intelHtml(R) {
  let h = "<p><b>CSD outstanding (not yet paid by CSD):</b> " + C.inr(R.total) + " across " + R.open.length + " bills" + (R.recvAsof ? " · Tally receivables as of " + esc(R.recvAsof) : "") + "</p>";
  h += "<p>Age: " + Object.keys(R.buckets).map((k) => k + " days " + C.inr(R.buckets[k])).join(" · ") + "</p>";
  h += "<p>CSD usually pays about <b>" + R.lag + " days</b> after the bill. Likely in the next 30 days: <b>" + C.inr(R.next30.amt) + "</b> (" + R.next30.n + " bills).</p>";
  if (R.skipped.length) h += "<h3>Skipped by CSD — newer bills of the same depot were paid (" + R.skipped.length + ")</h3><p style='color:#555'>Usually a missing document, GRN or a dispute at the depot. Worth a call.</p>" +
    table(["Bill", "Date", "Depot", "Amount", "Age"], R.skipped.slice(0, 25).map((r) => [esc(r.billNo), esc(r.date), esc(r.party.replace(/^.*?-\s*/, "")), C.inr(r.amt), r.age + " d"]));
  if (R.long.length) h += "<h3>Long pending (over 120 days) — " + R.long.length + "</h3>" + table(["Bill", "Date", "Depot", "Amount", "Age"], R.long.slice(0, 25).map((r) => [esc(r.billNo), esc(r.date), esc(r.party.replace(/^.*?-\s*/, "")), C.inr(r.amt), r.age + " d"]));
  if (R.parties.length) h += "<h3>By depot</h3>" + table(["Depot", "Bills", "Outstanding", "Oldest"], R.parties.slice(0, 15).map((p) => [esc(p.party.replace(/^.*?-\s*/, "")), p.n, C.inr(p.amt), p.oldest + " d"]));
  return h;
}
function toEnterHtml(list) {
  return table(["Bill", "Depot", "Bill amt", "TDS", "DB note", "Net received", "UTR / date"], list.map((r) => [esc(r.billNo), esc(r.depot), C.inr(r.billAmt), C.inr(r.tds), r.db ? C.inr(r.db) : "—", "<b>" + C.inr(r.net) + "</b>", esc(r.utr || "") + "<br>" + esc(r.utrDate || "")]));
}

exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const s = await T.settings();
  const state = (await C.kvGet("csd_mail_state")) || { seen: [], first: true };
  const log = { at: new Date().toISOString(), manual: !!b.manual, pos: [], advices: [], errors: [] };
  let newAdvice = false;
  try {
    // ---------- POs ----------
    const csd = (await C.kvGet("csd")) || { orders: [], forecasts: [] }; csd.orders = csd.orders || []; csd.forecasts = csd.forecasts || [];
    const have = new Set(csd.orders.map((o) => String(o.poNo || "").trim()).filter(Boolean));
    const { tok, messages } = await G.search("from:" + PO_FROM + " has:attachment newer_than:" + (state.first ? 60 : 6) + "d", 40);
    for (const m of messages.reverse()) {
      if (state.seen.indexOf(m.id) >= 0) continue;
      const pdfs = m.attachments.filter((a) => /\.pdf$/i.test(a.name));
      const stems = Array.from(new Set(pdfs.map((a) => (a.name.match(/^(\d{4,})/) || [])[1]).filter(Boolean)));
      if (!pdfs.length || (stems.length && stems.every((x) => have.has(x)))) { state.seen.push(m.id); continue; }
      try {
        const bufs = []; for (const a of pdfs.slice(0, 4)) bufs.push(await G.attachment(tok, m.id, a.id));
        const p = await C.readPO(bufs);
        const po = String(p.poNo || stems[0] || "").trim();
        if (po && have.has(po)) { state.seen.push(m.id); continue; }
        const o = C.poRecord(Object.assign(p, { poNo: po }), m.id);
        csd.orders.unshift(o); have.add(po);
        csd.forecasts.unshift({ id: "fc_" + Date.now(), period: o.poDate || C.todayIST(), fromPO: po, added: C.todayIST(), rows: o.depots.map((d) => ({ depot: d.depot, cases: d.cases })) });
        for (let i = 0; i < pdfs.length && i < bufs.length; i++) { try { await T.vaultSaveFile("CSD PO " + po + " - " + pdfs[i].name, "application/pdf", bufs[i], { kind: "csd_po", data: [], by: "email", source: "email", from: m.from }); } catch (e) {} }
        // production orders for the shop floor (same list Virupaksha sees on the Production page); skipped if already created
        try {
          const prod = (await C.kvGet("production_v1")) || { orders: [] }; prod.orders = prod.orders || [];
          const NAMES = { "13094": 'ONAM Agarbatti Sandal 7.5" (100 Sticks)', "13095": "ONAM A/Batti 15 Sticks", "13130": 'ONAM Agarbatti Rose 7.5" (100 Sticks)', "13132": 'ONAM Agarbatti 3 Fragrance 7.5" (100 Sticks)' };
          let added = 0;
          (o.lines || []).forEach((l) => { const cs = +l.cases || 0; if (!cs) return;
            if (prod.orders.some((x) => x.csdPo === po && x.csdIndex === String(l.index))) return;
            prod.orders.unshift({ id: "p_" + Math.random().toString(36).slice(2, 9), logs: [], unit: "cases", notes: "Auto from CSD PO " + po + " (email)", entryId: null,
              product: NAMES[String(l.index)] || l.name || String(l.index), customer: "CSD PO " + po, startDate: C.todayIST(), targetCases: cs, promisedDate: o.deliveryTo || "", csdPo: po, csdIndex: String(l.index) });
            added++; });
          if (added) { await C.kvSet("production_v1", prod); log.pos.push("→ " + added + " production order(s) created"); }
        } catch (e) { log.errors.push("production orders: " + e.message); }
        const cases = (o.lines || []).reduce((t, l) => t + (+l.cases || 0), 0);
        log.pos.push(po + ": " + cases + " cases, " + o.depots.length + " depots");
        await T.tg("🛡️ <b>New CSD PO " + esc(po) + "</b> added to the CSD desk\n" + cases + " cases · " + o.depots.length + " depots" + (o.deliveryTo ? " · deliver by " + o.deliveryTo : "") + "\n" + (o.lines || []).map((l) => "• " + l.index + ": " + l.cases + " cs").join("\n"));
      } catch (e) { log.errors.push("PO mail " + m.id + ": " + e.message); continue; }
      state.seen.push(m.id);
    }
    if (log.pos.length) await C.kvSet("csd", csd);

    // ---------- payment advices ----------
    const pay = (await C.kvGet("csd_payments")) || { statements: [] }; pay.statements = pay.statements || [];
    const r2 = await G.search("from:" + PAY_FROM + " has:attachment filename:pdf newer_than:" + (state.first ? 150 : 10) + "d", 15);
    for (const m of r2.messages.reverse()) {
      if (state.seen.indexOf(m.id) >= 0) continue;
      for (const a of m.attachments.filter((x) => /\.pdf$/i.test(x.name))) {
        try {
          const buf = await G.attachment(r2.tok, m.id, a.id);
          const st = await C.readAdvice(buf);
          const url = await T.vaultSaveFile("CSD payment advice - " + a.name, "application/pdf", buf, { kind: "csd_payment", data: [], by: "email", source: "email", from: m.from });
          if (!st.bills.length) { log.advices.push(a.name + ": no bill lines found (kept in vault)"); continue; }
          const known = new Set(); pay.statements.forEach((x) => (x.bills || []).forEach((y) => known.add(y.billNo + "|" + y.utr)));
          const dup = st.bills.filter((y) => known.has(y.billNo + "|" + y.utr)).length;
          if (dup >= 0.8 * st.bills.length) { log.advices.push(a.name + ": already on file (" + st.period + ")"); continue; }
          pay.statements.unshift({ id: "stmt_" + Date.now(), period: st.period, uploaded: C.todayIST(), billCount: st.bills.length, totals: st.totals, declared: st.declared,
            mismatch: st.mismatch, matched: 0, debitTotal: st.bills.reduce((t, y) => t + ((+y.dbNoteAmt || 0) < 0 ? -y.dbNoteAmt : 0), 0), bills: st.bills, source: "email", subject: m.subject, file: url || "" });
          newAdvice = true;
          log.advices.push(a.name + ": " + st.period + " · " + st.bills.length + " lines · paid " + C.inr(st.totals.paidAmt) + (st.mismatch.length ? " ⚠️ totals differ: " + st.mismatch.join(", ") : " ✓ totals agree"));
        } catch (e) { log.errors.push("Advice " + a.name + ": " + e.message); }
      }
      state.seen.push(m.id);
    }
    if (newAdvice) await C.kvSet("csd_payments", pay);
  } catch (e) { log.errors.push(e.message); }

  state.first = false; state.seen = state.seen.slice(-500);
  state.log = [log].concat(state.log || []).slice(0, 40);

  // ---------- reconcile + tell people ----------
  let R = null; try { R = await C.reconcile(); } catch (e) { log.errors.push("reconcile: " + e.message); }
  if (R && newAdvice) {
    const adv = log.advices.filter((x) => /lines/.test(x));
    let h = "<p>New CSD payment advice read from email:</p><ul>" + adv.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>";
    h += "<h3>Receipts still to be entered in Tally (" + R.toEnter.length + ")</h3>" + (R.toEnter.length ? toEnterHtml(R.toEnter.slice(0, 60)) : "<p>None — Tally already shows them received.</p>");
    h += intelHtml(R) + "<p><a href='" + SITE + "/tally/?tab=csd'>Open Tally → CSD</a></p>";
    await mail(s.ownerEmail, "CSD payment advice: " + adv.length + " read, " + R.toEnter.length + " receipts to enter, outstanding " + C.inr(R.total), wrap(h));
    if (R.toEnter.length) await mail(s.accountantEmail, "CSD receipts to enter in Tally (" + R.toEnter.length + " bills)", wrap("<p>Hello Maadhu,</p><p>CSD has paid these bills (payment advice attached in the Tally vault). Tally still shows them as outstanding — please enter the receipts <b>bill-wise</b> against each bill, with TDS and any debit note as shown.</p>" +
      toEnterHtml(R.toEnter) + "<p>Once entered, they drop off this list automatically after the next Receivables export.</p><p>Thank you.</p>"));
    await T.tg("🛡️ <b>CSD payment advice read</b>\n" + adv.join("\n") + "\n\n" + R.toEnter.length + " receipts sent to Maadhu to enter · outstanding " + C.inr(R.total) + (R.skipped.length ? " · " + R.skipped.length + " bills skipped by CSD" : ""));
  }
  // Monday morning: outstanding intelligence
  const dow = new Date(Date.now() + 5.5 * 3600e3).getUTCDay();
  if (R && dow === 1 && state.lastIntel !== C.todayIST() && !b.manual) {
    await mail(s.ownerEmail, "CSD receivables — weekly: " + C.inr(R.total) + " outstanding, " + R.long.length + " over 120 days", wrap(intelHtml(R) +
      (R.toEnter.length ? "<h3>Still not entered in Tally: " + R.toEnter.length + " receipts</h3>" : "") + "<p><a href='" + SITE + "/tally/?tab=csd'>Open Tally → CSD</a></p>"));
    if (R.toEnter.length) await mail(s.accountantEmail, "Reminder: " + R.toEnter.length + " CSD receipts still to enter in Tally", wrap("<p>Hello Maadhu,</p><p>These CSD receipts are still open in Tally:</p>" + toEnterHtml(R.toEnter) + "<p>Thank you.</p>"));
    state.lastIntel = C.todayIST();
  }
  if (log.errors.length) await T.tg("⚠️ CSD mail import: " + log.errors.slice(0, 3).join(" | "));
  await C.kvSet("csd_mail_state", state);
  return { statusCode: 200, body: "ok" };
};
