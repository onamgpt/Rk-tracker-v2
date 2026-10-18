// Professional & compliance bills (auditor, CA, consultants, ROC/legal, GST
// practitioner…). Upload the invoice (or pick it from email) — Claude reads it:
// vendor, GSTIN, number, date, service, taxable value, GST, total — and
// suggests the TDS (s.194J 10% for professional / technical fees; 194C for
// contracts). Tracks paid / unpaid, the yearly compliance cost, GST credit and
// TDS to deposit. TDS suggestions must be confirmed by the CA.
const r0 = (n) => Math.round(Number(n) || 0);
const days = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const fyStart = (d) => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return (m >= 4 ? y : y - 1) + "-04-01"; };
const CATS = ["Statutory audit", "Tax audit / income tax", "GST filing & advisory", "ROC / company secretarial", "Legal", "Consultancy", "Accounting / bookkeeping", "Certification / licences", "Other professional"];

const PROMPT = `Read this invoice addressed to Onam Agarbathi Pvt Ltd (Bangalore). Return ONLY JSON:
{"vendor":"","gstin":"","invNo":"","invDate":"YYYY-MM-DD","desc":"service described, short","category":one of ${JSON.stringify(CATS)},
 "taxable":number,"cgst":number,"sgst":number,"igst":number,"total":number,"due":"YYYY-MM-DD or empty",
 "tdsSection":"194J" | "194C" | "194H" | "194I" | "none","tdsRate":number (percent),"tdsNote":"one line why"}
Rules: use only what is printed; amounts in rupees as plain numbers; 0 when a tax is absent.
TDS is on the amount EXCLUDING GST: professional / technical / audit / legal / consultancy fees → 194J at 10% (2% if clearly "technical services" or a call-centre); contract work → 194C at 2% for a company/firm, 1% for an individual; commission → 194H; rent → 194I; "none" if the vendor is a government body or the fee is a government fee.`;

async function extract(buf, mime, name) {
  const isPdf = /pdf/i.test(mime || "") || /\.pdf$/i.test(name || "");
  const isImg = /^image\//i.test(mime || "") || /\.(jpe?g|png|webp|gif)$/i.test(name || "");
  if (!isPdf && !isImg) return { error: "Please upload a PDF or a photo of the invoice" };
  const media = isPdf ? "application/pdf" : (/png/i.test(mime + name) ? "image/png" : /webp/i.test(mime + name) ? "image/webp" : "image/jpeg");
  const block = isPdf ? { type: "document", source: { type: "base64", media_type: media, data: buf.toString("base64") } }
                      : { type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } };
  for (const model of ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }] }) });
      const j = await r.json(); if (!r.ok) continue;
      let t = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").replace(/```json|```/g, "").trim();
      const s = t.indexOf("{"), e = t.lastIndexOf("}"); if (s >= 0 && e > s) t = t.slice(s, e + 1);
      return normalise(JSON.parse(t));
    } catch (e) {}
  }
  return { error: "Couldn't read the invoice — please enter the details by hand" };
}

function normalise(x) {
  const n = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const o = { vendor: String(x.vendor || "").slice(0, 100), gstin: String(x.gstin || "").toUpperCase().slice(0, 15), invNo: String(x.invNo || "").slice(0, 40),
    invDate: /^\d{4}-\d{2}-\d{2}$/.test(x.invDate || "") ? x.invDate : "", desc: String(x.desc || "").slice(0, 160), category: CATS.includes(x.category) ? x.category : "Other professional",
    taxable: n(x.taxable), cgst: n(x.cgst), sgst: n(x.sgst), igst: n(x.igst), total: n(x.total), due: /^\d{4}-\d{2}-\d{2}$/.test(x.due || "") ? x.due : "",
    tdsSection: ["194J", "194C", "194H", "194I", "none"].includes(x.tdsSection) ? x.tdsSection : "194J", tdsRate: n(x.tdsRate), tdsNote: String(x.tdsNote || "").slice(0, 160) };
  if (!o.total) o.total = n(o.taxable + o.cgst + o.sgst + o.igst);
  if (!o.taxable && o.total) o.taxable = n(o.total - o.cgst - o.sgst - o.igst);
  return compute(o);
}
// TDS on the value before GST; amount to pay the vendor = total − TDS
function compute(o) {
  if (o.tdsSection === "none") o.tdsRate = 0;
  o.tds = Math.round((o.taxable || 0) * (o.tdsRate || 0) / 100);
  o.netPayable = Math.round((o.total || 0) - o.tds);
  if (!o.due && o.invDate) o.due = addDays(o.invDate, 15);
  return o;
}

function summary(list, today) {
  const fy = fyStart(today), cur = (list || []).filter((x) => (x.invDate || x.added || "").slice(0, 10) >= fy);
  const byCat = {}, byVendor = {};
  cur.forEach((x) => { byCat[x.category] = (byCat[x.category] || 0) + (x.taxable || 0); byVendor[x.vendor || "?"] = (byVendor[x.vendor || "?"] || 0) + (x.taxable || 0); });
  const unpaid = (list || []).filter((x) => x.status !== "paid");
  return { fy, count: cur.length, costExGst: r0(cur.reduce((a, x) => a + (x.taxable || 0), 0)), gstCredit: r0(cur.reduce((a, x) => a + (x.cgst || 0) + (x.sgst || 0) + (x.igst || 0), 0)),
    tdsThisYear: r0(cur.reduce((a, x) => a + (x.tds || 0), 0)), unpaidCount: unpaid.length, unpaidNet: r0(unpaid.reduce((a, x) => a + (x.netPayable || 0), 0)),
    overdue: unpaid.filter((x) => x.due && x.due < today).length,
    byCategory: Object.keys(byCat).map((k) => ({ k, v: r0(byCat[k]) })).sort((a, b) => b.v - a.v),
    byVendor: Object.keys(byVendor).map((k) => ({ k, v: r0(byVendor[k]) })).sort((a, b) => b.v - a.v).slice(0, 10) };
}

// due in 3 days, on the day, then weekly overdue; TDS deposit reminder on the 3rd for last month's TDS
function reminders(list, today) {
  const out = [];
  (list || []).filter((x) => x.status !== "paid" && x.due).forEach((x) => {
    const l = days(today, x.due);
    if (l === 3 || l === 0 || (l < 0 && (-l) % 7 === 0)) out.push({ key: x.id + "|" + today, text: (x.vendor || "?") + " bill " + (x.invNo || "") + " — pay ₹" + r0(x.netPayable).toLocaleString("en-IN") +
      (x.tds ? " after deducting TDS ₹" + r0(x.tds).toLocaleString("en-IN") + " (" + x.tdsSection + ")" : "") + (l < 0 ? " — OVERDUE " + -l + " d" : l === 0 ? " — due today" : " — due in 3 days") });
  });
  if (today.slice(8) === "03") {
    const m = new Date(today + "T00:00:00Z"); m.setUTCMonth(m.getUTCMonth() - 1); const ym = m.toISOString().slice(0, 7);
    const t = (list || []).filter((x) => x.status === "paid" && (x.paidOn || "").slice(0, 7) === ym && x.tds > 0);
    if (t.length) out.push({ key: "tds|" + ym, text: "TDS deducted from professional bills paid in " + ym + ": ₹" + r0(t.reduce((a, x) => a + x.tds, 0)).toLocaleString("en-IN") + " (" + t.map((x) => x.vendor).join(", ") + ") — deposit by the 7th" });
  }
  return out;
}
module.exports = { extract, normalise, compute, summary, reminders, CATS };
