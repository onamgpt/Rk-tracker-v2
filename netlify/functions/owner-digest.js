// 19:30 IST daily: one email to Ravi with everything the tracker held for him today
// (purchase & production, CSD, invoices, dispatch, inventory, Tally reminders, weekly and monthly reports).
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function run(opt) {
  opt = opt || {};
  const cur = (await call({ action: "getPortfolio", user: "main", key: "owner_digest" })).data || { items: [] };
  const items = cur.items || [];
  if (!items.length) return { skipped: "nothing held" };
  const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
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
  return { sent: ok, items: items.length };
}
exports.run = run;
exports.handler = async () => { try { return { statusCode: 200, body: JSON.stringify(await run({})) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
