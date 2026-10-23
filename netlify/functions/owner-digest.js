// 19:30 IST daily: one email to Ravi with everything the tracker held for him today
// (purchase & production, CSD, invoices, dispatch, inventory, Tally reminders, weekly and monthly reports).
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The email is the full record; WhatsApp is the nudge that makes him open it.
// Queued, not sent — wa-scheduler drains the queue and the Mac Mini bridge
// delivers it. Never let a WhatsApp failure affect the email result.
async function wa(text) {
  try {
    const rows = await require("./wa-lib.js").send("ravi", text);
    return rows.length > 0;
  } catch (e) { return false; }
}

async function run(opt) {
  opt = opt || {};
  const cur = (await call({ action: "getPortfolio", user: "main", key: "owner_digest" })).data || { items: [] };
  const items = cur.items || [];
  const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  // Send even on an empty day. Silence is ambiguous — it looks identical to the
  // job having failed — so a "nothing held" mail is itself the signal that the
  // chain ran. Ravi asked for this explicitly.
  if (!items.length) {
    const hb = "<div style='font-family:Arial,sans-serif;font-size:15px;color:#16181c;max-width:780px'>" +
      "<p style='font-size:18px'><b>Your daily summary \u2014 " + esc(day) + "</b></p>" +
      "<p style='color:#555'>Nothing was held for you today \u2014 no purchase, production, CSD, invoice, " +
      "dispatch, inventory or Tally items came through.</p>" +
      "<p style='color:#888;font-size:13px'>This mail is sent every day whether or not there is anything " +
      "in it, so that a silent evening means a problem rather than a quiet day.</p>" +
      "<p style='margin-top:26px'><a href='https://rk-tracker-v2.netlify.app/'>Open the tracker</a></p></div>";
    const rb = await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({
      to: "onamagarbathi@gmail.com", subject: "Daily summary " + day + " \u2014 nothing held",
      html: hb, direct: true }) });
    const okb = JSON.parse(rb.body || "{}").ok;
    if (okb) await call({ action: "savePortfolio", user: "main", key: "owner_digest",
      data: { items: [], lastSent: new Date().toISOString() } });
    const wb = await wa("Onam daily summary " + day + "\nNothing was held for you today.\n" +
      "https://rk-tracker-v2.netlify.app/");
    return { sent: okb, whatsapp: wb, items: 0, empty: true };
  }
  const time = (iso) => new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(11, 16);
  let h = "<div style='font-family:Arial,sans-serif;font-size:15px;color:#16181c;max-width:780px'>" +
    "<p style='font-size:18px'><b>Your daily summary — " + esc(day) + "</b></p>" +
    "<p style='color:#555'>" + items.length + " update(s) today:</p><ol style='color:#333'>" + items.map((x) => "<li>" + esc(x.subject) + "</li>").join("") + "</ol>";
  items.forEach((x, i) => {
    h += "<hr style='border:0;border-top:2px solid #1d3557;margin:26px 0 10px'><p style='color:#1d3557;font-size:16px'><b>" + (i + 1) + ". " + esc(x.subject) + "</b> <span style='color:#888;font-size:12px'>" + time(x.at) + "</span></p>" +
      (x.html ? x.html : "<div style='white-space:pre-wrap'>" + esc(x.text) + "</div>");
  });
  h += "<p style='margin-top:26px'><a href='https://rk-tracker-v2.netlify.app/'>Open the tracker</a></p></div>";
  const r = await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to: "onamagarbathi@gmail.com", subject: "Daily summary " + day + " — " + items.length + " update(s)", html: h, direct: true }) });
  const ok = JSON.parse(r.body || "{}").ok;
  if (ok) await call({ action: "savePortfolio", user: "main", key: "owner_digest", data: { items: [], lastSent: new Date().toISOString() } });
  // Headline list on WhatsApp, detail in the email.
  const lines = items.slice(0, 12).map((x, i) => (i + 1) + ". " + String(x.subject || "").slice(0, 70));
  const more = items.length > 12 ? "\n...and " + (items.length - 12) + " more" : "";
  const w = await wa("Onam daily summary " + day + " \u2014 " + items.length + " update(s)\n\n" +
    lines.join("\n") + more + "\n\nFull detail in your email.\nhttps://rk-tracker-v2.netlify.app/");
  return { sent: ok, whatsapp: w, items: items.length };
}
exports.run = run;
exports.handler = async () => { try { return { statusCode: 200, body: JSON.stringify(await run({})) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
