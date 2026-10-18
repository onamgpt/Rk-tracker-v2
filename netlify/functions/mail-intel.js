// Inbox intelligence — once a day, read new emails in onamagarbathi@gmail.com
// (read-only), let Claude sort out the business ones (customer payments and
// orders, supplier invoices and payment chasers, auditor/CA bills, bank alerts,
// GST / tax / government notices, export documents, insurance & licences…),
// and keep a short summary of each for the advisor and the Health tab.
// Email bodies are NOT stored — only a one-line summary and the key facts.
// Personal and promotional mail is skipped without a summary.
const G = require("./gmail.js");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });

const CATS = ["customer_payment", "customer_order", "customer_issue", "supplier_invoice", "supplier_chasing_payment", "professional_bill", "bank_alert",
  "gst_tax_notice", "govt_compliance", "export_docs", "legal", "insurance_licence", "staff_hr", "logistics", "other_business", "personal", "promo_spam"];
const LABEL = { customer_payment: "Customer payment", customer_order: "Customer order", customer_issue: "Customer issue", supplier_invoice: "Supplier invoice",
  supplier_chasing_payment: "Supplier chasing payment", professional_bill: "CA / professional bill", bank_alert: "Bank alert", gst_tax_notice: "GST / tax notice",
  govt_compliance: "Government / compliance", export_docs: "Export documents", legal: "Legal", insurance_licence: "Insurance / licence", staff_hr: "Staff / HR",
  logistics: "Logistics", other_business: "Business", personal: "Personal", promo_spam: "Promotions" };
// our own tracker emails — never re-read them
const OWN = /morning brief|weekly review|tally audit check|compliance (due|& bank)|reminder: tally documents|production reminder|renewals due|ask your ca|backup/i;

const PROMPT = `You sort emails for Ravi, director of Onam Agarbathi Pvt Ltd (incense manufacturer, Bangalore; customers include CSD/CPC defence canteens, distributors, exporters; suppliers of raw bathi, perfumery compounds, packaging).
For EACH email return an object with:
 "i": the email's index,
 "cat": one of ${JSON.stringify(CATS)},
 "imp": "high" | "medium" | "low"  (high = money at stake, a deadline, a government/tax/legal notice, an unhappy supplier or customer, a declined/failed payment),
 "summary": one short line in plain English (what it is and what it means for Onam) — empty for personal/promo_spam,
 "party": the company/person concerned (or ""),
 "amount": rupee amount if stated (number, else null),
 "due": a deadline as YYYY-MM-DD if stated (else ""),
 "action": what Ravi or his team should do (or "") .
Use only what the email says. Return ONLY a JSON array.`;

async function classify(batch) {
  const content = PROMPT + "\n\nEMAILS:\n" + batch.map((m, i) => "#" + i + "\nFrom: " + m.from + "\nSubject: " + m.subject + "\nDate: " + m.date +
    (m.attachments && m.attachments.length ? "\nAttachments: " + m.attachments.map((a) => a.name).join(", ") : "") + "\nText: " + String(m.body || "").replace(/\s+/g, " ").slice(0, 1400)).join("\n\n");
  for (const model of ["claude-haiku-4-5-20251001", "claude-sonnet-5-5"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: "user", content }] }) });
      const j = await r.json(); if (!r.ok) continue;
      let t = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").replace(/```json|```/g, "").trim();
      const s = t.indexOf("["), e = t.lastIndexOf("]"); if (s >= 0 && e > s) t = t.slice(s, e + 1);
      const arr = JSON.parse(t); if (Array.isArray(arr)) return arr;
    } catch (e) {}
  }
  return null;
}

async function scan(opts) {
  opts = opts || {};
  const st = (await kvGet("mail_intel")) || { items: [], seen: [] };
  const seen = new Set(st.seen || []);
  let messages = [];
  try { messages = (await G.search("newer_than:" + (opts.days || 2) + "d -in:sent -in:chats -category:promotions -category:social", opts.max || 60)).messages || []; }
  catch (e) { st.error = e.message; st.at = new Date().toISOString(); await kvSet("mail_intel", st); return { error: e.message }; }
  const fresh = messages.filter((m) => !seen.has(m.id) && !OWN.test(m.subject || ""));
  let added = 0;
  for (let k = 0; k < fresh.length; k += 10) {
    const batch = fresh.slice(k, k + 10);
    const res = await classify(batch);
    batch.forEach((m, i) => {
      seen.add(m.id);
      const r = (res || []).find((x) => x && Number(x.i) === i);
      if (!r || r.cat === "personal" || r.cat === "promo_spam") return;          // nothing kept for personal / promo mail
      st.items.unshift({ id: m.id, at: m.internalDate ? new Date(m.internalDate).toISOString() : new Date().toISOString(), from: String(m.from || "").replace(/<[^>]+>/, "").trim().slice(0, 80),
        subject: String(m.subject || "").slice(0, 140), cat: CATS.includes(r.cat) ? r.cat : "other_business", imp: ["high", "medium", "low"].includes(r.imp) ? r.imp : "low",
        summary: String(r.summary || "").slice(0, 240), party: String(r.party || "").slice(0, 80), amount: r.amount == null ? null : Number(r.amount) || null,
        due: /^\d{4}-\d{2}-\d{2}$/.test(r.due || "") ? r.due : "", action: String(r.action || "").slice(0, 200), attach: (m.attachments || []).map((a) => a.name).slice(0, 5),
        files: (m.attachments || []).filter((a) => /pdf|image/i.test(a.type || "") || /\.(pdf|jpe?g|png)$/i.test(a.name || "")).slice(0, 4).map((a) => ({ name: a.name, id: a.id, type: a.type })), status: "open" });
      added++;
    });
  }
  st.items = st.items.slice(0, 500);
  st.seen = Array.from(seen).slice(-3000);
  st.at = new Date().toISOString(); st.error = "";
  await kvSet("mail_intel", st);
  return { added, checked: fresh.length };
}

// The last few days of business email, for the advisor and the Health tab
function recent(st, days) {
  const cut = Date.now() - (days || 3) * 864e5;
  return ((st && st.items) || []).filter((x) => new Date(x.at).getTime() >= cut);
}
function factsFor(st) {
  const r = recent(st, 3), byCat = {};
  r.forEach((x) => { byCat[LABEL[x.cat] || x.cat] = (byCat[LABEL[x.cat] || x.cat] || 0) + 1; });
  const pick = r.filter((x) => x.imp !== "low" && x.status !== "done").slice(0, 25).map((x) => ({ type: LABEL[x.cat], importance: x.imp, from: x.from, party: x.party, summary: x.summary, amount: x.amount, due: x.due, action: x.action }));
  const chasing = ((st && st.items) || []).filter((x) => x.cat === "supplier_chasing_payment" && Date.now() - new Date(x.at).getTime() < 30 * 864e5);
  const chaseCount = {}; chasing.forEach((x) => { const p = x.party || x.from; chaseCount[p] = (chaseCount[p] || 0) + 1; });
  return { last3days: byCat, needsAttention: pick, suppliersChasingPayment30d: chaseCount };
}
module.exports = { scan, recent, factsFor, LABEL, CATS };
