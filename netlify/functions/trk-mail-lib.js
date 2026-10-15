// Server-side version of the tracker's "#Trackerv23" email import, run each
// morning: reads tagged emails from Gmail, lets Claude read the invoice/order
// (PDF or image attachments), and saves an entry exactly like the in-app
// "Import" button does. Attachments go to private Supabase storage.
const db = require("./db.js");
const G = require("./gmail.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const PROMPT = "You are an expert Indian accountant parsing a business email for Onam Agarbathi Pvt. Ltd. (incense manufacturer, Bangalore).\nRULES:\n- Email FROM a supplier/vendor (Chemixil, raw material, chemical, packaging) = category Business - Purchase\n- Email about SALES order to dealer/customer = Sales - Order\n- Payment confirmation = Sales - Payment or Business - Purchase\n- Title must be SHORT: VendorName Invoice Rs.Amount for purchase, CustomerName Order for sales\n- NEVER use Onam Agarbathi as vendor \u2014 that is the buyer not seller\n- Extract EXACT rupee total (Grand Total / Amount Chargeable / Total)\n- Payment terms: 60 days credit = reminderDays 60, 30 days = 30, immediate = 0\n- Read ALL attached images/PDFs carefully\nReturn ONLY valid JSON:\n{\"title\":\"Chemixil Invoice Rs.350528\",\"category\":\"Business - Purchase\",\"amount\":\"350528\",\"vendor\":\"Chemixil Corporation\",\"person\":\"\",\"invoiceNo\":\"26-27/453\",\"paymentTerms\":\"60 days\",\"reminderDays\":60,\"paymentStatus\":\"Payment Pending\",\"notes\":\"Product details | CGST | SGST | Total\",\"summary\":\"brief summary\"}\n";
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const istDate = (ms) => new Date((ms || Date.now()) + 5.5 * 3600e3).toISOString().slice(0, 10);

async function claude(content) {
  for (const model of ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 1200, system: "Return ONLY valid JSON no markdown.", messages: [{ role: "user", content }] }) });
      const j = await r.json(); if (!r.ok) continue;
      const t = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      let c = t.replace(/```json|```/g, "").trim(); const s = c.indexOf("{"), e = c.lastIndexOf("}"); if (s >= 0 && e > s) c = c.slice(s, e + 1);
      return JSON.parse(c);
    } catch (e) {}
  }
  return null;
}

async function importTrackerEmails(days) {
  const seen = (await kvGet("trk_mail_seen")) || [];
  const { tok, messages } = await G.search("subject:(trackerv2 OR trackerv23) -subject:uploadcpc newer_than:" + (days || 3) + "d", 15);
  const fresh = messages.filter((m) => !seen.includes(m.id));
  if (!fresh.length) return { imported: [], note: "no new #Trackerv23 emails" };
  const all = await call({ action: "getAll", user: "main" });
  const known = (all.entries || []).map((e) => e.notes || "").join("\n");
  const imported = [];
  for (const m of fresh.reverse()) {
    seen.push(m.id);
    if (known.includes(m.id)) continue;   // already imported by hand in the app
    const date = istDate(m.internalDate);
    const atts = [];
    for (const a of m.attachments.filter((x) => /pdf|image/.test(x.type || "")).slice(0, 3)) {
      try { const buf = await G.attachment(tok, m.id, a.id); if (buf.length < 4.5 * 1024 * 1024) atts.push({ name: a.name, type: a.type, buf }); } catch (e) {}
    }
    const content = [];
    const pdf = atts.find((a) => /pdf/.test(a.type));
    if (pdf) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.buf.toString("base64") } });
    else atts.filter((a) => /image/.test(a.type)).slice(0, 3).forEach((a) => content.push({ type: "image", source: { type: "base64", media_type: a.type, data: a.buf.toString("base64") } }));
    content.push({ type: "text", text: PROMPT + "\nEmail Subject: " + m.subject + "\nFrom: " + m.from + "\nDate: " + date + "\nBody: " + String(m.body || "").slice(0, 800) });
    const obj = await claude(content);
    // keep the files (private Supabase storage)
    const files = [];
    for (const a of atts) { try { const r = await db.storageUpload("main", { name: a.name, type: a.type, data: a.buf.toString("base64") }); if (r && r.url) files.push({ name: a.name, type: "drive", data: r.url }); } catch (e) {} }
    const driveLinks = (String(m.body || "").match(/https:\/\/(?:drive|docs)\.google\.com\/[^\s"<>]+/g) || []).slice(0, 3).map((l) => ({ name: "Invoice (Drive)", type: "drive", data: l }));
    const allAtts = files.concat(driveLinks);
    const first = allAtts[0];
    let reminder = "", reminderNote = "";
    if (obj && obj.reminderDays > 0) { const rd = new Date(date); rd.setDate(rd.getDate() + parseInt(obj.reminderDays, 10)); reminder = rd.toISOString().slice(0, 10);
      reminderNote = "Pay by " + rd.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) + " (" + obj.reminderDays + " day credit)"; }
    const title = (obj && obj.title) || (obj && obj.vendor ? obj.vendor + (obj.amount ? " Rs." + Number(obj.amount).toLocaleString("en-IN") : "") : m.subject);
    const entry = { id: genId(), title, date, category: (obj && obj.category) || "Business - Purchase", person: (obj && obj.person) || "", vendor: (obj && obj.vendor) || "",
      amount: obj && obj.amount ? String(obj.amount) : "", paymentStatus: (obj && obj.paymentStatus) || "Payment Pending", reminder, reminderNote, taskType: (obj && obj.taskType) || "",
      link: (first && first.data) || "", linkLabel: first ? "📎 Invoice" : "",
      notes: ((obj && obj.notes) || "") + (obj && obj.invoiceNo ? " | Inv: " + obj.invoiceNo : "") + (obj && obj.paymentTerms ? " | Terms: " + obj.paymentTerms : "") + (first ? " | 📎 " + first.data : "") + " [gmailId:" + m.id + "] [auto 9:15]",
      attachments: allAtts, tags: ["Payment Due"], createdAt: new Date().toISOString() };
    const subj = String(m.subject || "").toLowerCase();
    let user = "main";
    const route = { "#prakash": "prakash", "#staff1": "staff1", "#staff2": "staff2", "#staff3": "staff3", "#staff4": "staff4" };
    for (const t in route) if (subj.includes(t)) { user = route[t]; break; }
    const officers = { "#sooraj": "Sooraj", "#sunil": "Sunil", "#biju": "Biju", "#murugan": "Murugan", "#sebi": "Sebi", "#sugeesh": "Sugeesh", "#satish": "Satish", "#sadasivan": "Sadasivan", "#vinod": "Vinod" };
    for (const t in officers) if (subj.includes(t)) { entry.category = "Sales - Order"; entry.tags = entry.tags.concat(["Sales Order", "Officer: " + officers[t]]); break; }
    const r = await call({ action: "save", entry, user });
    imported.push((r && r.ok ? "✓ " : "✗ ") + title + (user !== "main" ? " → " + user : ""));
  }
  await kvSet("trk_mail_seen", seen.slice(-1500));
  return { imported };
}
module.exports = { importTrackerEmails };
