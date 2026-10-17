// "Ask AI" for the Tally page. Builds a compact picture of the stored Tally
// figures, asks Claude, and saves the answer to kv "tally_ask_<id>" for the
// page to collect. Read-only: never changes any Tally data.
const T = require("./tally.js");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const r0 = (n) => Math.round(Number(n) || 0);
const isSale = (t) => /sales/i.test(t) && !/order|return|credit/i.test(t);

function billsBlock(rows, label) {
  rows = rows || [];
  if (!rows.length) return label + ": not uploaded.\n";
  const by = {};
  rows.forEach((r) => { const p = r.party || "?"; const x = by[p] || (by[p] = { amt: 0, n: 0, oldest: 0, over90: 0 }); x.amt += r.amt || 0; x.n++; x.oldest = Math.max(x.oldest, r.over || 0); if ((r.over || 0) > 90) x.over90 += r.amt || 0; });
  const b = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  rows.forEach((r) => { const o = r.over || 0; b[o <= 30 ? "0-30" : o <= 60 ? "31-60" : o <= 90 ? "61-90" : "90+"] += r.amt || 0; });
  const parties = Object.keys(by).sort((a, z) => by[z].amt - by[a].amt).slice(0, 60);
  return label + " — total ₹" + r0(rows.reduce((a, r) => a + (r.amt || 0), 0)) + " in " + rows.length + " bills; ageing " + Object.keys(b).map((k) => k + "d ₹" + r0(b[k])).join(", ") +
    "\nBy party (party | total ₹ | bills | oldest days | over 90 days ₹):\n" + parties.map((p) => p + " | " + r0(by[p].amt) + " | " + by[p].n + " | " + by[p].oldest + " | " + r0(by[p].over90)).join("\n") + "\n";
}
async function context() {
  const [meta, tb, recv, pay, stock, vch, lr] = await Promise.all(["tally_meta", "tally_tb", "tally_recv", "tally_pay", "tally_stock", "tally_vouchers", "logistics_v2"].map(kvGet));
  const V = (vch && vch.list) || [];
  let out = "TALLY DATA for Onam Agarbathi Pvt Ltd (amounts in ₹). Day Book covers " + (V.length ? V[0].d + " to " + V[V.length - 1].d : "nothing yet") + ".\n\n";
  // Trial balance
  out += (tb && tb.rows && tb.rows.length) ? "TRIAL BALANCE (as of " + (tb.asof || "?") + "; name | debit | credit):\n" + tb.rows.map((r) => r.name + " | " + r0(r.dr) + " | " + r0(r.cr)).join("\n") + "\n\n" : "Trial balance: not uploaded.\n\n";
  // Voucher type totals per month
  const byM = {};
  V.forEach((v) => { const m = v.d.slice(0, 7), t = v.t || "?"; (byM[m] = byM[m] || {})[t] = (byM[m][t] || 0) + (v.a || 0); });
  out += "MONTHLY TOTALS BY VOUCHER TYPE:\n" + Object.keys(byM).sort().map((m) => m + ": " + Object.keys(byM[m]).sort((a, z) => byM[m][z] - byM[m][a]).slice(0, 12).map((t) => t + " " + r0(byM[m][t])).join("; ")).join("\n") + "\n\n";
  // Sales by customer, overall and per month
  const S = V.filter((v) => isSale(v.t)), byP = {}, byPM = {};
  S.forEach((v) => { byP[v.p] = (byP[v.p] || 0) + v.a; const k = v.p + "|" + v.d.slice(0, 7); byPM[k] = (byPM[k] || 0) + v.a; });
  const tops = Object.keys(byP).sort((a, z) => byP[z] - byP[a]).slice(0, 40), months = Object.keys(byM).sort();
  out += "SALES BY CUSTOMER (customer | total | per month " + months.join(",") + "):\n" + tops.map((p) => p + " | " + r0(byP[p]) + " | " + months.map((m) => r0(byPM[p + "|" + m] || 0)).join(",")).join("\n") + "\n\n";
  // Products, if the Day Book had item lines
  const byI = {}; S.forEach((v) => (v.i || []).forEach((it) => { byI[it.i] = (byI[it.i] || 0) + (it.a || 0); }));
  const ti = Object.keys(byI).sort((a, z) => byI[z] - byI[a]).slice(0, 30);
  if (ti.length) out += "SALES BY PRODUCT:\n" + ti.map((i) => i + " | " + r0(byI[i])).join("\n") + "\n\n";
  // Recent vouchers
  const recent = V.slice(-250);
  out += "LAST " + recent.length + " VOUCHERS (date | type | no | party | amount):\n" + recent.map((v) => v.d + " | " + v.t + " | " + v.n + " | " + v.p + " | " + r0(v.a)).join("\n") + "\n\n";
  out += billsBlock(recv && recv.rows, "RECEIVABLES (money customers owe)") + "\n" + billsBlock(pay && pay.rows, "PAYABLES (money we owe suppliers)") + "\n";
  const st = (stock && stock.rows) || [];
  out += st.length ? "STOCK (item | qty | value):\n" + st.slice().sort((a, z) => z.val - a.val).slice(0, 150).map((r) => r.item + " | " + r.qty + " " + (r.unit || "") + " | " + r0(r.val)).join("\n") + "\n\n" : "Stock: not uploaded.\n\n";
  const nos = {}; V.forEach((v) => { nos[String(v.n).replace(/\s+/g, "").toLowerCase()] = 1; });
  const miss = ((lr && lr.shipments) || []).filter((x) => x.invoiceNo && !nos[String(x.invoiceNo).replace(/\s+/g, "").toLowerCase()]);
  out += "DISPATCHES WITH NO MATCHING TALLY INVOICE: " + (miss.length ? miss.slice(0, 40).map((x) => x.customer + " inv " + x.invoiceNo + " (" + (x.dispatchedOn || x.date || "") + ")").join("; ") : "none") + "\n";
  // Bank statements (uploaded separately as CSV / Excel)
  const bank = await kvGet("tally_bank"), A = (bank && bank.accounts) || {};
  const accs = Object.keys(A);
  if (!accs.length) out += "\nBANK STATEMENTS: none uploaded yet.\n";
  accs.forEach((name) => {
    const t = A[name].txns || []; if (!t.length) return;
    const bm = {}; t.forEach((x) => { const m = x.d.slice(0, 7), y = bm[m] || (bm[m] = { inn: 0, out: 0, n: 0 }); y.inn += x.cr || 0; y.out += x.dr || 0; y.n++; });
    const who = (x) => String(x.desc || "").replace(/\d{4,}/g, "").replace(/[^A-Za-z ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "?";
    const ins = {}, outs = {}; t.forEach((x) => { if (x.cr) ins[who(x)] = (ins[who(x)] || 0) + x.cr; if (x.dr) outs[who(x)] = (outs[who(x)] || 0) + x.dr; });
    const top = (o2) => Object.keys(o2).sort((a, z) => o2[z] - o2[a]).slice(0, 25).map((k) => k + " " + r0(o2[k])).join("; ");
    out += "\nBANK ACCOUNT \"" + name + "\" — " + t.length + " transactions " + t[0].d + " to " + t[t.length - 1].d + (t[t.length - 1].bal != null ? ", closing balance ₹" + r0(t[t.length - 1].bal) : "") +
      "\nMonthly (month | money in | money out | count): " + Object.keys(bm).sort().map((m) => m + " " + r0(bm[m].inn) + "/" + r0(bm[m].out) + "/" + bm[m].n).join("; ") +
      "\nBiggest sources of money in: " + top(ins) + "\nBiggest payments out: " + top(outs) +
      "\nLast " + Math.min(200, t.length) + " transactions (date | narration | ref | out | in | balance):\n" + t.slice(-200).map((x) => x.d + " | " + x.desc + " | " + (x.ref || "") + " | " + (x.dr ? r0(x.dr) : "") + " | " + (x.cr ? r0(x.cr) : "") + " | " + (x.bal == null ? "" : r0(x.bal))).join("\n") + "\n";
  });
  out += "\nLast uploads: " + JSON.stringify(meta || {}).slice(0, 600) + "\n";
  return out;
}
async function claude(model, system, messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1800, system, messages }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("AI error " + r.status));
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
}
exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const key = "tally_ask_" + String(b.id || "").replace(/[^a-z0-9]/gi, "");
  try {
    const ctx = await context();
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const system = "You are the finance assistant for Ravikiran, director of Onam Agarbathi Pvt Ltd (incense maker, Bangalore; sells to general trade, CSD/CPC canteen stores and export). " +
      "Answer ONLY from the Tally data provided; if the data doesn't contain the answer, say exactly what's missing (e.g. 'upload the Receivables report'). Today is " + today + ". " +
      "Be concise and practical: lead with the answer, use Indian number format (₹1,23,456 / lakh / crore), short bullet points or a small table when useful, and finish with 1-3 suggested actions where relevant. " +
      "Point out anything that looks wrong in the books (mismatches, very old balances) when it matters to the question. You cannot change Tally data and you are not a chartered accountant.";
    const hist = Array.isArray(b.history) ? b.history.slice(-6) : [];
    const messages = [{ role: "user", content: ctx + "\n\nQuestion: " + (hist.length ? hist[0].q : b.q) }];
    if (hist.length) { hist.forEach((h, i) => { messages.push({ role: "assistant", content: h.a || "" }); messages.push({ role: "user", content: i === hist.length - 1 ? b.q : hist[i + 1].q }); }); }
    let answer = "", err = null;
    for (const model of ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]) { try { answer = await claude(model, system, messages); if (answer) break; } catch (e) { err = e; } }
    if (!answer) throw err || new Error("No answer");
    await kvSet(key, { status: "done", answer, at: new Date().toISOString() });
    const log = (await kvGet("tally_ask_log")) || [];
    log.unshift({ at: new Date().toISOString(), q: String(b.q).slice(0, 500), a: answer.slice(0, 4000) });
    await kvSet("tally_ask_log", log.slice(0, 40));
  } catch (e) { await kvSet(key, { status: "error", error: String(e.message || e) }); }
  return { statusCode: 200, body: "ok" };
};
