// Purchase & Stock — every morning 09:40 IST (after the 09:15 Tally email import).
//  • Prakash / Virupaksha: their "to order" list + orders that are late from the supplier
//  • Ravi: one summary of both, plus whether Tally stock data is current
//  • Maadhu: a how-to when the Stock Summary is missing or old (at most every 3 days)
const L = require("./purchase-lib.js");
const OWNER_CHAT = "8632288596";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => (n == null ? "—" : (Math.round(n * 100) / 100).toLocaleString("en-IN"));

async function mail(to, subject, html) {
  if (!to) return { ok: false };
  try { const r = await require("./mail.js").handler({ httpMethod: "POST", body: JSON.stringify({ to, subject, html }) }); return JSON.parse(r.body || "{}"); }
  catch (e) { return { ok: false, error: String(e) }; }
}
async function tg(chatIds, text) {
  chatIds = (chatIds || []).filter(Boolean); if (!chatIds.length) return;
  const base = process.env.URL || L.SITE;
  try { await fetch(base + "/.netlify/functions/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", chatIds, message: text }) }); } catch (e) {}
}
const wrap = (inner) => "<div style='font-family:Arial,sans-serif;font-size:15px;color:#16181c;max-width:720px'>" + inner + "</div>";
const btn = (href, t) => "<p style='margin:22px 0'><a href='" + href + "' style='background:#1d3557;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none'>" + t + "</a></p>";
const TH = "style='text-align:left;padding:7px 8px;border-bottom:2px solid #ccc;font-size:13px'";
const TD = "style='padding:7px 8px;border-bottom:1px solid #e5e5e5;font-size:14px;vertical-align:top'";

function orderTable(rows) {
  return "<table style='border-collapse:collapse;width:100%'><tr><th " + TH + ">Item</th><th " + TH + ">In stock</th><th " + TH + ">Order</th><th " + TH + ">Last supplier</th><th " + TH + ">Why</th></tr>" +
    rows.map((r) => "<tr><td " + TD + "><b>" + esc(r.item) + "</b></td><td " + TD + ">" + fmt(r.qty) + " " + esc(r.unit) +
      (r.daysLeft != null ? "<br><span style='color:#b42318'>~" + r.daysLeft + " days</span>" : "") + "</td><td " + TD + "><b>" + fmt(r.order) + " " + esc(r.unit) + "</b></td><td " + TD + ">" +
      esc(r.supplier || "—") + (r.lastPurchase && r.lastPurchase.rate ? "<br><span style='color:#666'>last ₹" + fmt(r.lastPurchase.rate) + " on " + esc(r.lastPurchase.d) + "</span>" : "") +
      "</td><td " + TD + ">" + esc(r.why || "") + "</td></tr>").join("") + "</table>";
}
function lateTable(list) {
  return "<table style='border-collapse:collapse;width:100%'><tr><th " + TH + ">PO</th><th " + TH + ">Item</th><th " + TH + ">Supplier</th><th " + TH + ">Ordered</th><th " + TH + ">Was due</th></tr>" +
    list.map((p) => "<tr><td " + TD + ">" + esc(p.poNo || "") + "</td><td " + TD + "><b>" + esc(p.item) + "</b><br>" + fmt(p.orderedQty) + " " + esc(p.unit || "") +
      ((p.receivedQty || 0) > 0 ? " (got " + fmt(p.receivedQty) + ")" : "") + "</td><td " + TD + ">" + esc(p.supplier || "—") + "</td><td " + TD + ">" + esc(p.orderedOn) + "</td><td " + TD +
      " ><span style='color:#b42318'>" + esc(p.expected) + "</span></td></tr>").join("") + "</table>";
}

async function run(opt) {
  opt = opt || {};
  const D = await L.load();
  const s = D.s, today = L.todayIST();
  if (!opt.force && s.lastRun === today) return { skipped: "already ran today" };
  L.autoReceive(D);
  const P = L.plan(D);
  L.syncSuggestions(D, P);
  await L.kvSet("purchase_pos", D.pos);
  const lg = (await L.kvGet("logistics_settings")) || {};
  const chats = { prakash: lg.prakashChat || "", viru: lg.viruChat || "" };
  const sent = [];
  const staleNote = !P.hasStock ? "No Stock Summary from Tally has arrived yet — the list below uses physical counts and production needs only."
    : (P.stale > 2 ? "Tally stock is from " + P.asof + " (" + P.stale + " days old) — check the actual stock before ordering." : "");

  for (const who of ["prakash", "viru"]) {
    if (opt.only && opt.only !== who) continue;
    const todo = P.rows.filter((r) => r.order && r.owner === who);
    const late = P.overdue.filter((p) => p.owner === who);
    if (!todo.length && !late.length) continue;
    const link = L.SITE + "/purchase/?user=" + who;
    let h = "<p>Good morning " + L.NAMES[who] + ",</p>";
    if (staleNote) h += "<p style='background:#fbf3dd;padding:10px;border-radius:6px'>" + esc(staleNote) + "</p>";
    if (todo.length) h += "<h3 style='margin:18px 0 8px'>To order today (" + todo.length + ")</h3>" + orderTable(todo) +
      "<p style='color:#555'>After placing an order, tap <b>Ordered</b> on the page and enter the supplier's delivery date. If something isn't needed, tap <b>Not now</b>.</p>";
    if (late.length) h += "<h3 style='margin:18px 0 8px'>Late from supplier (" + late.length + ")</h3>" + lateTable(late) +
      "<p style='color:#555'>Please call the supplier, then update the new date on the page — or mark it received.</p>";
    h += btn(link, "Open Purchase & Stock");
    if (s.emailStaff !== false) { const r = await mail(s[who + "Email"], "Purchase list — " + (todo.length ? todo.length + " to order" : "") + (todo.length && late.length ? ", " : "") + (late.length ? late.length + " late" : "") + " (" + today + ")", wrap(h)); sent.push(who + ": " + (r.ok ? "emailed" : "email failed")); }
    if (chats[who]) await tg([chats[who]], "🧾 <b>Purchase list " + today + "</b>\n" + todo.map((r) => "• " + r.item + " — order " + fmt(r.order) + " " + r.unit).join("\n") +
      (late.length ? "\n\n⏰ Late: " + late.map((p) => p.item + " (" + (p.supplier || "?") + ")").join(", ") : "") + "\n\n" + link);
  }

  // Ravi
  const all = P.rows.filter((r) => r.order);
  const setup = P.rows.filter((r) => r.cat === "other" || (r.track && !r.owner)).length;
  if (s.emailOwner !== false && (!opt.only || opt.only === "main") && (all.length || P.overdue.length || opt.force)) {
    let h = "<p>Purchase & Stock — " + today + "</p>";
    h += "<p><b>Tally stock:</b> " + (P.hasStock ? "as of " + esc(P.asof) + (P.stale > 2 ? " <span style='color:#b42318'>(" + P.stale + " days old)</span>" : "") : "<span style='color:#b42318'>not received yet from Maadhu</span>") + "</p>";
    ["prakash", "viru"].forEach((who) => {
      const t = all.filter((r) => r.owner === who), l = P.overdue.filter((p) => p.owner === who);
      h += "<h3 style='margin:18px 0 8px'>" + L.NAMES[who] + " — " + t.length + " to order, " + l.length + " late</h3>" + (t.length ? orderTable(t) : "") + (l.length ? "<br>" + lateTable(l) : "");
    });
    if (setup) h += "<p style='color:#555'>" + setup + " item(s) need a person or category set on the Stock tab.</p>";
    h += btn(L.SITE + "/purchase/?user=main", "Open Purchase & Stock");
    const r = await mail(s.ownerEmail, "Purchase & Stock: " + all.length + " to order, " + P.overdue.length + " late (" + today + ")", wrap(h));
    sent.push("Ravi: " + (r.ok ? "emailed" : "email failed"));
    if (all.length || P.overdue.length) await tg([OWNER_CHAT], "🧾 <b>Purchase " + today + "</b>: " + all.length + " to order, " + P.overdue.length + " late from supplier.\n" + L.SITE + "/purchase/?user=main");
  }

  // Maadhu: Stock Summary missing / old → how-to, at most every 3 days
  if ((!P.hasStock || P.stale > 2) && (!s.lastMaadhu || L.daysBetween(s.lastMaadhu, today) >= 3) && !opt.only) {
    const h = "<p>Hello Maadhu,</p><p>Please include the <b>Stock Summary</b> in the daily Tally backup email" + (P.hasStock ? " (the last one we have is from " + esc(P.asof) + ")" : "") + ". It is used to plan raw material, perfume, box and carton purchases.</p>" +
      "<ol><li>TallyPrime → <b>Display More Reports → Stock Summary</b> (or Gateway → Stock Summary).</li>" +
      "<li>Press <b>Alt+F5</b> (Detailed) so every <b>item</b> shows, not just the groups. Keep the date as today.</li>" +
      "<li>Press <b>Ctrl+E</b> (Export) → Format: <b>XML (Data Interchange)</b> → Export.</li>" +
      "<li>Attach the file to the usual email to onamagarbathi@gmail.com with <b>backup</b> in the subject, together with the Day Book.</li></ol>" +
      "<p>Also: please make sure the <b>Day Book export includes inventory details</b> (item, quantity) for purchase bills — the tracker uses them to close purchase orders automatically.</p><p>Thank you.</p>";
    const r = await mail(s.maadhuEmail, "Please add the Stock Summary to the daily Tally backup", wrap(h));
    s.lastMaadhu = today; sent.push("Maadhu: " + (r.ok ? "stock how-to emailed" : "email failed"));
  }
  if (!opt.force) s.lastRun = today;
  await L.kvSet("purchase_settings", s);
  return sent;
}
exports.run = run;
exports.handler = async () => { try { const r = await run({}); return { statusCode: 200, body: JSON.stringify(r) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
