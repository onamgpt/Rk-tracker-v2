// Monday 08:00 IST: attendance summary for the last 7 days, sent to Ravi only.
const G = require("./gate.js");
const P = require("./purchase-lib.js");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TH = "style='text-align:left;padding:6px 7px;border-bottom:2px solid #ccc;font-size:13px'", TD = "style='padding:6px 7px;border-bottom:1px solid #e5e5e5;font-size:13px'";

function summarise(W, S, from, to) {
  const days = []; for (let d = from; d <= to; d = G.addDays(d, 1)) days.push(d);
  const rows = W.map((w) => {
    const mine = S.filter((s) => s.wid === w.id && s.d >= from && s.d <= to && (s.dir === "IN" || s.dir === "OUT"));
    const present = new Set(mine.filter((s) => s.dir === "IN").map((s) => s.d));
    const flags = [];
    days.forEach((d) => {
      const day = mine.filter((s) => s.d === d); if (!day.length) return;
      const ins = day.filter((s) => s.dir === "IN").length, outs = day.filter((s) => s.dir === "OUT").length;
      if (ins > outs) flags.push(d + ": in without out");
      const dups = S.filter((s) => s.wid === w.id && s.d === d && s.dir === "DUP").length;
      if (dups) flags.push(d + ": repeat scan attempt x" + dups);
    });
    return { name: w.name, active: w.active, days: present.size, flags };
  });
  const bad = S.filter((s) => s.dir === "BAD" && s.d >= from && s.d <= to);
  return { from, to, rows, bad: bad.length, badDetail: bad.slice(-10) };
}

async function run(opt) {
  opt = opt || {};
  const s = await P.settings();
  const { W, S } = await G.loadAll();
  const today = G.todayIST();
  const to = G.addDays(today, -1), from = G.addDays(to, -6);
  const r = summarise(W, S, from, to);
  const flagged = r.rows.filter((x) => x.flags.length);
  const dayHtml = r.rows.map((x) => "<tr><td " + TD + ">" + esc(x.name) + (x.active ? "" : " <span style='color:#888'>(cancelled)</span>") + "</td><td " + TD + "><b>" + x.days + "</b> of 7</td><td " + TD + ">" +
    (x.flags.length ? x.flags.map((f) => "<div style='color:#b42318'>" + esc(f) + "</div>").join("") : "<span style='color:#1F7A4D'>none</span>") + "</td></tr>").join("");
  const html = "<div style='font-family:Arial,sans-serif;font-size:15px;color:#16181c;max-width:720px'>" +
    "<p><b>Gate attendance, " + esc(from) + " to " + esc(to) + "</b></p>" +
    "<p>" + W.filter((w) => w.active).length + " active workers. " + flagged.length + " with something to check. Unrecognised or cancelled card scans: " + r.bad + ".</p>" +
    "<table style='border-collapse:collapse;width:100%'><tr><th " + TH + ">Worker</th><th " + TH + ">Days present</th><th " + TH + ">To check</th></tr>" + dayHtml + "</table>" +
    "<p style='color:#555;font-size:13px'>Wages and statutory figures will follow once the salary sheet is loaded.</p></div>";
  const subject = "Gate attendance " + from + " to " + to + (flagged.length ? " — " + flagged.length + " to check" : "");
  const mr = await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to: [s.ownerEmail], subject, html }) });
  return { sent: JSON.parse(mr.body || "{}").ok ? "owner" : "failed", flagged: flagged.length };
}
exports.run = run; exports.summarise = summarise;
exports.handler = async () => { try { return { statusCode: 200, body: JSON.stringify(await run({})) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
