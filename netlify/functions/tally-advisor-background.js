// AI advisor — reads the company health facts (computed, not guessed) and
// writes a short brief with wins, warnings and concrete decisions. Daily after
// the 9:15 import; a deeper review on Mondays (or when asked).
const T = require("./tally.js");
const H = require("./tally-health.js");
const MI = require("./mail-intel.js");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const inr = (n) => (n < 0 ? "-" : "") + "₹" + Math.abs(Math.round(Number(n) || 0)).toLocaleString("en-IN");

const SYSTEM = `You are the financial and operations advisor to Ravi, director of Onam Agarbathi Pvt Ltd (incense manufacturer, Bangalore; sells to CSD/CPC defence canteens, general trade and exports to the Gulf under LUT).
You receive FACTS computed from Tally, bank statements, dispatch, production, compliance and field-sales data. Rules:
- Use ONLY numbers present in the facts. Never invent figures, parties or dates. If something can't be judged from the data, say what data is missing.
- Be direct and practical, like a sharp CFO talking to the owner. Short sentences. Indian number style (lakh / crore) is fine.
- Decisions must be specific: who, what, how much, by when — and why (the number behind it).
- Include genuine wins (be warm but not flattering). Include what is being missed or slipping (people, deadlines, data).
- Cash is tight: when suggesting supplier payments, protect critical raw-material suppliers (raw bathi, perfumery compounds, packaging) and statutory dues first, and keep payments fair across suppliers.
- You are not a CA; flag tax/legal points as "check with the CA" rather than ruling on them.
- "inbox" holds summaries of the last 3 days of business email (customer payments/orders, supplier invoices and payment chasers, CA bills, bank alerts, tax/government notices, export documents). Bring urgent ones into the decisions, and use "suppliersChasingPayment30d" when advising on fair supplier payments.
- If profitYTD.reliable is false or a ratio is null, do NOT draw conclusions from it — say what data is needed instead (dataNote / profitYTD.note explain).
Return ONLY JSON: {"headline":"one line","mood":"good|watch|act","wins":["…"],"warnings":["…"],"decisions":[{"do":"…","why":"…"}],"profit":"2-3 sentences on whether the business is making profit and where","people":["admin/people points"],"ask_ca":["questions to raise with the CA"],"think":"one thought-provoking question for Ravi"}`;

async function claude(facts, deep) {
  const user = (deep ? "WEEKLY DEEP REVIEW — cover trends across months, ratios and structural issues, up to 6 decisions.\n" : "DAILY BRIEF — keep it tight: what changed, what needs action today/this week, up to 4 decisions.\n") +
    "FACTS (JSON):\n" + JSON.stringify(facts);
  for (const model of ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: deep ? 2500 : 1500, system: SYSTEM, messages: [{ role: "user", content: user }] }) });
      const j = await r.json(); if (!r.ok) continue;
      let t = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").replace(/```json|```/g, "").trim();
      const s = t.indexOf("{"), e = t.lastIndexOf("}"); if (s >= 0 && e > s) t = t.slice(s, e + 1);
      return JSON.parse(t);
    } catch (e) {}
  }
  return null;
}

function factsFor(h, deep) {
  const f = { date: h.today, healthScore: h.score, ratios: h.ratios, lights: h.lights, balances: h.balances, last90days: h.last90, profitYTD: h.pl, cashNext4Weeks: h.cash4w,
    alerts: h.alerts, overdueCustomers: h.overdueCustomers, overdueSuppliers: h.overdueSuppliers, paidMostLast90: h.paidTo, topCustomers90: h.topCustomers,
    admin: h.admin, crossChecks: h.cross, bank: h.bankFlow, dataNote: h.dataNote };
  f.months = deep ? h.months : h.months.slice(-3);
  if (!deep) delete f.topCustomers90;
  return f;
}

function html(a, h, deep) {
  const L = { green: "🟢", amber: "🟠", red: "🔴", grey: "⚪" };
  const R = h.ratios, Lt = h.lights, f1 = (x, s) => (x == null ? "—" : Math.round(x * 10) / 10 + (s || ""));
  const li = (arr) => (arr || []).map((x) => "<li>" + x + "</li>").join("");
  return "<div style='font-family:Arial,sans-serif;font-size:14px;line-height:1.55;max-width:720px'>" +
    "<h2 style='margin:0 0 4px'>" + (a.headline || "Company brief") + "</h2><div style='color:#667'>" + h.today + " · Health score <b>" + (h.score == null ? "—" : h.score + "/100") + "</b>" + (deep ? " · weekly review" : "") + "</div>" +
    "<h3>✅ Decisions</h3><ol>" + (a.decisions || []).map((d) => "<li><b>" + d.do + "</b><br><span style='color:#555'>" + d.why + "</span></li>").join("") + "</ol>" +
    (a.wins && a.wins.length ? "<h3>🎉 Wins</h3><ul>" + li(a.wins) + "</ul>" : "") +
    (a.warnings && a.warnings.length ? "<h3>⚠️ Watch</h3><ul>" + li(a.warnings) + "</ul>" : "") +
    "<h3>💰 Profit</h3><p>" + (a.profit || "") + "</p>" +
    (a.people && a.people.length ? "<h3>👥 People & admin</h3><ul>" + li(a.people) + "</ul>" : "") +
    (a.ask_ca && a.ask_ca.length ? "<h3>📞 Ask the CA</h3><ul>" + li(a.ask_ca) + "</ul>" : "") +
    "<h3>📊 Ratios</h3><table cellpadding='5' style='border-collapse:collapse;font-size:13px'>" +
    [["Current ratio", f1(R.currentRatio), Lt.currentRatio], ["Days to collect (DSO)", f1(R.dso, " d"), Lt.dso], ["Days to pay suppliers (DPO)", f1(R.dpo, " d"), Lt.dpo], ["Stock days", f1(R.stockDays, " d"), Lt.stockDays],
     ["Cash cycle", f1(R.cashCycle, " d"), Lt.cashCycle], ["Collections vs sales (90 d)", f1(R.collection, "%"), Lt.collection], ["Purchases vs sales (90 d)", f1(R.purchaseToSales, "%"), Lt.purchaseToSales],
     ["Receivables over 90 days", f1(R.recv90plus, "%"), Lt.recv90plus], ["Payables over 90 days", f1(R.pay90plus, "%"), Lt.pay90plus], ["OD limit used", f1(R.odUse, "%"), Lt.odUse]]
      .map((r) => "<tr style='border-top:1px solid #eee'><td>" + L[r[2]] + " " + r[0] + "</td><td align='right'><b>" + r[1] + "</b></td></tr>").join("") + "</table>" +
    (a.think ? "<p style='margin-top:16px;padding:10px;background:#f4f6f8;border-radius:8px'>💭 " + a.think + "</p>" : "") +
    "<p><a href='https://rk-tracker-v2.netlify.app/tally/'>Open the Health tab</a></p></div>";
}

exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const deep = !!b.deep || new Date(today + "T00:00:00Z").getUTCDay() === 1;
  try { await MI.scan({ days: 2 }); } catch (e) {}          // read new business email first
  const d = await H.load(kvGet);
  const h = H.compute(d, today, d.settings);
  const facts = factsFor(h, deep);
  try { facts.inbox = MI.factsFor(await kvGet("mail_intel")); } catch (e) {}
  const a = await claude(facts, deep);
  const rec = { at: new Date().toISOString(), deep, health: h, advice: a, error: a ? "" : "The AI could not write the brief this time — figures are still up to date." };
  await kvSet("tally_advice", rec);
  const hist = (await kvGet("tally_advice_hist")) || [];
  hist.unshift({ at: rec.at, deep, score: h.score, headline: a && a.headline, mood: a && a.mood });
  await kvSet("tally_advice_hist", hist.slice(0, 90));
  if (a && !b.quiet) {
    const s = await T.settings();
    const icon = { good: "🟢", watch: "🟠", act: "🔴" }[a.mood] || "🧭";
    await T.tg(icon + " <b>" + (deep ? "Weekly review" : "Morning brief") + "</b> · health " + (h.score == null ? "—" : h.score + "/100") + "\n" + a.headline + "\n\n" +
      (a.decisions || []).slice(0, 4).map((x, i) => (i + 1) + ". " + x.do).join("\n") + (a.wins && a.wins[0] ? "\n\n🎉 " + a.wins[0] : "") + "\n\nFull brief emailed · https://rk-tracker-v2.netlify.app/tally/");
    try { await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to: s.ownerEmail, subject: (deep ? "Weekly review: " : "Morning brief: ") + (a.headline || "Onam Agarbathi"), html: html(a, h, deep) }) }); } catch (e) {}
  }
  return { statusCode: 200, body: "ok" };
};
exports._internal = { factsFor, html };
