// CSD automation (read-only on Tally):
//  • POs mailed by mgrgp2@gmail.com      → CSD desk orders (kv "csd"), same shape as a manual upload
//  • payment advices from pafa@csdindia.gov.in → CSD Payments statements (kv "csd_payments"), Tally vault,
//    matched bill-by-bill against Tally receivables → receipts for Maadhu to enter, outstanding + intelligence
const G = require("./gmail.js");
const kvGet = G.kvGet, kvSet = G.kvSet;
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const days = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const isCSD = (party) => /canteen\s*stores|\bcsd\b/i.test(String(party || ""));
const billKey = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");

async function claudePdfs(pdfs, prompt, system) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const content = pdfs.map((b) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b.toString("base64") } }));
  content.push({ type: "text", text: prompt });
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16000, system, messages: [{ role: "user", content }] }) });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || "model error");
  const txt = (d.content || []).map((c) => c.text || "").join("");
  const clean = txt.replace(/```json/g, "").replace(/```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  return JSON.parse(s >= 0 ? clean.substring(s, e + 1) : clean);
}

// ---- POs (same prompt and shape as the CSD desk's manual upload) ----
async function readPO(pdfs) {
  const shape = '{"poNo":"","poDate":"","deliveryFrom":"","deliveryTo":"","lines":[{"index":"13130","name":"","casePack":240,"rate":7999.2,"cases":178}],"allocation":[{"depot":"CHENNAI","cases":{"13130":20,"13132":11}}]}';
  const prompt = "These files are a Canteen Stores Department (CSD, Ministry of Defence) purchase order and/or its depot-wise allocation sheet. Extract everything.\n" +
    "Return ONLY JSON in exactly this shape (this is an example, use the real values):\n" + shape + "\n" +
    "The allocation table lists depot names down the left, and one column of case counts per index number. Map each depot to its cases for each index. A blank cell means zero - omit it.\nDates as YYYY-MM-DD.";
  return claudePdfs(pdfs, prompt, "Return ONLY valid JSON. Read the depot allocation table carefully, column by column.");
}
function poRecord(p, mailId) {
  const depots = (p.allocation || []).map((a) => ({ depot: a.depot, cases: a.cases || {}, stage: "pending", invoiceNo: "", lr: "", transport: 0, received: 0 }));
  return { id: "csd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6), poNo: String(p.poNo || ""), poDate: p.poDate || "", deliveryFrom: p.deliveryFrom || "",
    deliveryTo: p.deliveryTo || "", lines: p.lines || [], depots, source: "email", mailId, imported: todayIST() };
}

// ---- payment advice (same shape as the CSD Payments manual upload) ----
async function readAdvice(pdf) {
  const shape = '{"period":"01-AUG-26 to 31-AUG-26","bills":[{"billNo":"2025-26/698","billDate":"2025-10-30","billAmt":28479,"crNoteAmt":0,"dbNoteAmt":0,"tdsAmt":-28,"adjAmt":0,"depot":"BDB","docType":"BILL","utr":"PUNBN620260114545899","utrDate":"2026-01-14","memoNo":"271423","memoDate":"2025-12-31"}],"declared":{"billAmt":9361908,"crNoteAmt":0,"dbNoteAmt":-34081,"tdsAmt":-8965,"adjAmt":0,"paidAmt":9318862}}';
  const prompt = "This is a CSD (Canteen Stores Department) official payment/realisation statement. Bills are grouped under 'Utr Num / Date' + 'Memo Num/Date' headers; each line has document type (BILL/DEBIT/CREDIT), bill number, bill date, bill amount, CR note, DB note, TDS, Adj amount and depot code. The grand totals are at the end ('Total Bill Amount', 'Total CR Note Amt', 'Total DB Note Amt', 'Total TDS Note Amt', 'Total Adj Amt', 'Total Paid Amt').\n" +
    "Return ONLY JSON in exactly this shape (example values):\n" + shape + "\n" +
    "Include EVERY line across ALL UTR groups in one flat 'bills' array, each carrying its own utr, utrDate, memoNo and memoDate (a UTR number can wrap onto the next line — join it). Keep the signs as printed. 'declared' = the grand-total block. Dates as YYYY-MM-DD.";
  const sys = "Return ONLY valid JSON. Read every line of every UTR block, do not skip any.";
  let r = await claudePdfs([pdf], prompt, sys), chk = checkTotals(r);
  if (chk.length) { const r2 = await claudePdfs([pdf], prompt + "\nA previous reading missed lines — the line sums did not match the printed totals (" + chk.join(", ") + "). Read again, line by line.", sys); if (checkTotals(r2).length <= chk.length) { r = r2; chk = checkTotals(r2); } }
  const totals = {}; ["billAmt", "crNoteAmt", "dbNoteAmt", "tdsAmt", "adjAmt"].forEach((k) => (totals[k] = (r.bills || []).reduce((s, b) => s + (+b[k] || 0), 0)));
  totals.paidAmt = totals.billAmt + totals.crNoteAmt + totals.dbNoteAmt + totals.tdsAmt + totals.adjAmt;
  return { period: r.period || "", bills: r.bills || [], totals, declared: r.declared || {}, mismatch: chk };
}
function checkTotals(r) {
  const dec = r.declared || {}, bills = r.bills || [], out = [];
  ["billAmt", "dbNoteAmt", "tdsAmt"].forEach((k) => { if (dec[k] == null) return; const s = bills.reduce((t, b) => t + (+b[k] || 0), 0); if (Math.abs(s - dec[k]) > 2) out.push(k + " " + Math.round(s) + " vs " + dec[k]); });
  return out;
}

// ---- reconciliation + intelligence ----
async function reconcile() {
  const [pay, recv, csd, prev] = await Promise.all([kvGet("csd_payments"), kvGet("tally_recv"), kvGet("csd"), kvGet("csd_recon")]);
  const stmts = (pay && pay.statements) || [], today = todayIST();
  const rrows = ((recv && recv.rows) || []).filter((r) => isCSD(r.party));
  const recvAsof = (recv && (recv.asof || (recv.at || "").slice(0, 10))) || null;
  const openByBill = {}; rrows.forEach((r) => (openByBill[billKey(r.ref)] = r));
  // every bill CSD says it paid
  const paid = {}, lags = [], codeParty = {};
  stmts.forEach((s) => (s.bills || []).forEach((b) => {
    if (b.docType && b.docType !== "BILL") return;
    const k = billKey(b.billNo); if (!k) return;
    paid[k] = Object.assign({ stmt: s.period || s.uploaded, stmtId: s.id }, b);
    if (b.billDate && b.utrDate) lags.push(days(b.billDate, b.utrDate));
    const o = openByBill[k]; if (o && b.depot) codeParty[b.depot] = o.party;
  }));
  lags.sort((a, b) => a - b);
  const lag = lags.length ? lags[Math.floor(lags.length / 2)] : 90;
  // receipts Tally still shows as open although CSD has paid them → Maadhu enters these
  const toEnter = [];
  Object.keys(paid).forEach((k) => { const o = openByBill[k]; if (!o) return; const p = paid[k];
    toEnter.push({ billNo: p.billNo, billDate: p.billDate, depot: p.depot, party: o.party, tallyAmt: o.amt, billAmt: p.billAmt, tds: p.tdsAmt || 0, db: p.dbNoteAmt || 0, cr: p.crNoteAmt || 0,
      net: (p.billAmt || 0) + (p.crNoteAmt || 0) + (p.dbNoteAmt || 0) + (p.tdsAmt || 0) + (p.adjAmt || 0), utr: p.utr, utrDate: p.utrDate, stmt: p.stmt,
      diff: Math.round(((o.amt || 0) - (p.billAmt || 0)) * 100) / 100 }); });
  toEnter.sort((a, b) => (a.utrDate < b.utrDate ? -1 : 1));
  // truly outstanding = open in Tally and not in any statement
  const open = rrows.filter((r) => !paid[billKey(r.ref)]).map((r) => {
    const age = r.date && /^\d{4}/.test(r.date) ? days(r.date, today) : (r.over || 0);
    return { billNo: r.ref, date: r.date, party: r.party, amt: r.amt || 0, age, expected: r.date ? addDays(r.date, lag) : null };
  }).sort((a, b) => b.age - a.age);
  const buckets = { "0–60": 0, "61–90": 0, "91–180": 0, "180+": 0 };
  open.forEach((r) => { const k = r.age <= 60 ? "0–60" : r.age <= 90 ? "61–90" : r.age <= 180 ? "91–180" : "180+"; buckets[k] += r.amt; });
  const byParty = {}; open.forEach((r) => { const p = byParty[r.party] = byParty[r.party] || { party: r.party, amt: 0, n: 0, oldest: 0 }; p.amt += r.amt; p.n++; p.oldest = Math.max(p.oldest, r.age); });
  // skipped: a newer bill of the same depot was paid, this older one wasn't
  const newestPaid = {}; Object.values(paid).forEach((p) => { const party = codeParty[p.depot]; if (party && (!newestPaid[party] || p.billDate > newestPaid[party])) newestPaid[party] = p.billDate; });
  const skipped = open.filter((r) => newestPaid[r.party] && r.date && r.date < newestPaid[r.party] && r.age > lag);
  const next30 = open.filter((r) => r.expected && r.expected <= addDays(today, 30));
  const out = { at: new Date().toISOString(), today, recvAsof, lag, statements: stmts.length,
    toEnter, open: open.slice(0, 400), total: open.reduce((s, r) => s + r.amt, 0), buckets,
    parties: Object.values(byParty).sort((a, b) => b.amt - a.amt), skipped: skipped.slice(0, 100),
    long: open.filter((r) => r.age > 120).slice(0, 100),
    next30: { n: next30.length, amt: next30.reduce((s, r) => s + r.amt, 0) },
    debitNotes: Object.values(paid).filter((p) => (p.dbNoteAmt || 0) < 0).map((p) => ({ billNo: p.billNo, depot: p.depot, amt: p.dbNoteAmt, stmt: p.stmt })).slice(-60),
    orders: ((csd && csd.orders) || []).length, prevToEnter: prev ? (prev.toEnter || []).length : null };
  // mark CSD-desk depots paid where the invoice number matches a paid bill
  if (csd && csd.orders) { let ch = false;
    csd.orders.forEach((o) => (o.depots || []).forEach((d) => { const p = d.invoiceNo && paid[billKey(d.invoiceNo)];
      if (p && d.stage !== "paid") { d.stage = "paid"; d.reconciled = true; d.reconcileNote = "CSD statement " + p.stmt + " · bill " + p.billNo + " · UTR " + (p.utr || ""); ch = true; } }));
    if (ch) await kvSet("csd", csd); }
  await kvSet("csd_recon", out);
  return out;
}

module.exports = { kvGet, kvSet, todayIST, days, addDays, inr, isCSD, readPO, poRecord, readAdvice, reconcile, claudePdfs };
