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
  // Production page fills itself from Virupaksha's Tally entries (before planning, so balances are current)
  const synced = L.syncProduction(D);
  if (synced.length) { const pv = (await L.kvGet("production_v1")) || {}; pv.orders = D.prod; await L.kvSet("production_v1", pv); }
  const PR = L.productionReport(D);
  const P = L.plan(D);
  L.syncSuggestions(D, P);
  await L.kvSet("purchase_pos", D.pos);
  const lg = (await L.kvGet("logistics_settings")) || {};
  const chats = { prakash: lg.prakashChat || "", viru: lg.viruChat || "" };
  const sent = [];
  const staleNote = !P.hasStock ? "No Stock Summary from Tally has arrived yet — the list below uses physical counts and production needs only."
    : (P.stale > 2 ? "Tally stock is from " + P.asof + " (" + P.stale + " days old) — check the actual stock before ordering." : "");

  // One shared email: Ravi, Prakash and Virupaksha all get the full picture, their own items first.
  const all = P.rows.filter((r) => r.order);
  const setupN = P.rows.filter((r) => r.cat === "other" || (r.track && !r.owner)).length;
  const link = (u) => L.SITE + "/purchase/?user=" + u;
  const section = (who, mineFlag) => {
    const t2 = all.filter((r) => r.owner === who), l2 = P.overdue.filter((p) => p.owner === who);
    if (!t2.length && !l2.length) return "";
    return "<h3 style='margin:20px 0 8px'>" + L.NAMES[who] + (mineFlag ? " (yours)" : "") + " — " + t2.length + " to order" + (l2.length ? ", " + l2.length + " late" : "") + "</h3>" +
      (t2.length ? orderTable(t2) : "") + (l2.length ? "<br><b style='color:#b42318'>Late from supplier</b>" + lateTable(l2) : "");
  };
  const prodNote = (!D.pt.itemLevel ? "Production is not reaching the tracker yet: Maadhu must send the Day Book as <b>XML</b> (not Excel)." :
    !D.pt.vouchers ? "No production entries found in the Day Book yet — Virupaksha should enter each day's production in Tally as a Stock Journal." : "");
  const setupNote = P.setup.length ? "<p style='background:#fbf3dd;padding:10px;border-radius:6px'>Running production not yet counted in the purchase list: " + P.setup.map((s) => esc(s.product) + " (" + esc(s.why) + ")").join("; ") +
    ". Fix it on the Production tab.</p>" : "";
  const prodHtml = (() => {
    let h = "";
    if (PR.lastDay) h += "<h3 style='margin:18px 0 8px'>Production " + esc(PR.lastDay) + " (from Tally)</h3><table style='border-collapse:collapse;width:100%'><tr><th " + TH + ">Item</th><th " + TH + ">Made</th><th " + TH + ">Cases</th></tr>" +
      PR.output.map((o) => "<tr><td " + TD + ">" + esc(o.item) + "</td><td " + TD + ">" + fmt(o.qty) + " " + esc(o.unit) + "</td><td " + TD + ">" + (o.cases != null ? fmt(o.cases) : "—") + "</td></tr>").join("") + "</table>";
    if (synced.length) h += "<p style='color:#555'>" + synced.length + " Tally production entr" + (synced.length > 1 ? "ies were" : "y was") + " added to the Production page automatically.</p>";
    const ord = PR.orders.slice(0, 12);
    if (ord.length) h += "<h3 style='margin:18px 0 8px'>Open production orders</h3><table style='border-collapse:collapse;width:100%'><tr><th " + TH + ">Order</th><th " + TH + ">Made / target</th><th " + TH + ">Promised</th><th " + TH + ">Need / day vs last 7 days</th></tr>" +
      ord.map((o) => "<tr><td " + TD + ">" + (o.risk ? "⚠️ " : "") + "<b>" + esc(o.name) + "</b><br><span style='color:#666'>" + esc(o.product) + "</span></td><td " + TD + ">" + fmt(o.made) + " / " + fmt(o.target) + " cs</td><td " + TD + ">" + esc(o.promised || "—") +
        "</td><td " + TD + ">" + (o.need != null ? fmt(o.need) + " vs " + fmt(o.pace) : "—") + "</td></tr>").join("") + "</table>";
    if (PR.variance.length) h += "<h3 style='margin:18px 0 8px'>Material used above normal (last 7 days)</h3><table style='border-collapse:collapse;width:100%'><tr><th " + TH + ">Date / entry</th><th " + TH + ">Product</th><th " + TH + ">Material</th><th " + TH + ">Above normal</th></tr>" +
      PR.variance.map((x) => "<tr><td " + TD + ">" + esc(x.d) + " " + esc(x.vno) + "</td><td " + TD + ">" + esc(x.fg) + "</td><td " + TD + ">" + esc(x.item) + "</td><td " + TD + "><b style='color:#b42318'>+" + x.pct + "%</b></td></tr>").join("") + "</table><p style='color:#555'>Check for wastage or a wrong quantity in the Tally entry.</p>";
    return h;
  })();
  const recips = [["main", s.ownerEmail, s.emailOwner !== false], ["prakash", s.prakashEmail, s.emailStaff !== false], ["viru", s.viruEmail, s.emailStaff !== false]];
  const any = all.length || P.overdue.length || PR.output.length || PR.orders.some((o) => o.risk) || PR.variance.length;
  for (const [who, addr, on] of recips) {
    if (opt.only && opt.only !== who) continue;
    if (!on || !addr) continue;
    if (!any && !opt.force) continue;
    const order = ["prakash", "viru"].sort((a, c) => (a === who ? -1 : c === who ? 1 : 0));
    let h = "<p>Good morning " + L.NAMES[who] + ",</p><p>Purchase & Stock — " + today + ". <b>Tally stock:</b> " + (P.hasStock ? "as of " + esc(P.asof) + (P.stale > 2 ? " <span style='color:#b42318'>(" + P.stale + " days old)</span>" : "") : "<span style='color:#b42318'>not received yet</span>") + "</p>";
    if (staleNote) h += "<p style='background:#fbf3dd;padding:10px;border-radius:6px'>" + esc(staleNote) + "</p>";
    if (prodNote) h += "<p style='background:#fbf3dd;padding:10px;border-radius:6px'>" + prodNote + "</p>";
    h += setupNote;
    h += prodHtml;
    order.forEach((w) => { h += section(w, w === who); });
    if (!any) h += "<p>Nothing to order today.</p>";
    if (who === "main" && setupN) h += "<p style='color:#555'>" + setupN + " item(s) need a person or category set on the Stock tab.</p>";
    if (who !== "main") h += "<p style='color:#555'>After placing an order tap <b>Ordered</b> on the page and enter the supplier's delivery date. If an item isn't needed, tap <b>Not now</b>.</p>";
    h += btn(link(who), "Open Purchase & Stock");
    const mine = all.filter((r) => r.owner === who).length, late = P.overdue.filter((p) => p.owner === who).length;
    const subj = "Production & Purchase " + today + ": " + (who === "main" ? all.length + " to order, " + P.overdue.length + " late" : mine + " yours to order" + (late ? ", " + late + " late" : "") + " (" + all.length + " in total)");
    const r = await mail(addr, subj, wrap(h)); sent.push(L.NAMES[who] + ": " + (r.ok ? "emailed" : "email failed"));
  }
  for (const who of ["prakash", "viru"]) {
    const todo = all.filter((r) => r.owner === who), late = P.overdue.filter((p) => p.owner === who);
    if (opt.only && opt.only !== who) continue;
    if ((todo.length || late.length) && chats[who]) await tg([chats[who]], "🧾 <b>Purchase list " + today + "</b>\n" + todo.map((r) => "• " + r.item + " — order " + fmt(r.order) + " " + r.unit).join("\n") +
      (late.length ? "\n\n⏰ Late: " + late.map((p) => p.item + " (" + (p.supplier || "?") + ")").join(", ") : "") + "\n\n" + link(who));
  }
  if (any && !opt.only) await tg([OWNER_CHAT], "🧾 <b>Purchase " + today + "</b>: " + all.length + " to order, " + P.overdue.length + " late from supplier.\n" + L.SITE + "/purchase/?user=main");

  // Maadhu: Stock Summary missing / old → how-to, at most every 3 days
  const needXml = !D.pt.itemLevel || (!D.pt.vouchers && !D.pt.hasOut);
  if ((!P.hasStock || P.stale > 2 || needXml) && (!s.lastMaadhu || L.daysBetween(s.lastMaadhu, today) >= 3) && !opt.only) {
    const h = "<p>Hello Maadhu,</p><p>Two things are needed in the daily Tally backup email so purchases and production can be planned automatically:</p>" +
      (!P.hasStock || P.stale > 2 ? "<h3>1. Stock Summary (item-wise)" + (P.hasStock ? " — last one we have is from " + esc(P.asof) : "") + "</h3><ol><li>Gateway of Tally → <b>Stock Summary</b>, press <b>Alt+F5</b> (Detailed) so every item shows, date = today.</li><li><b>Ctrl+E</b> (Export) → Format <b>XML (Data Interchange)</b> → Export.</li></ol>" : "") +
      (needXml ? "<h3>" + (!P.hasStock || P.stale > 2 ? "2" : "1") + ". Day Book as XML, not Excel</h3><p>The Excel Day Book has no item or quantity lines, so Virupaksha's production entries and the purchase bills' items cannot be read.</p><ol><li>Gateway of Tally → <b>Day Book</b>, set the period (yesterday to today is enough).</li><li><b>Ctrl+E</b> (Export) → Format <b>XML (Data Interchange)</b>. In the export settings set <b>Show Inventory details / Include inventory entries = Yes</b>.</li></ol>" : "") +
      "<p>Attach the files to the usual email to onamagarbathi@gmail.com with <b>backup</b> in the subject. Please send the Day Book XML of a day when Virupaksha entered production, so the tracker can learn the voucher type name.</p><p>Thank you.</p>";
    const r = await mail(s.maadhuEmail, "Please add the Stock Summary to the daily Tally backup", wrap(h));
    s.lastMaadhu = today; sent.push("Maadhu: " + (r.ok ? "stock how-to emailed" : "email failed"));
  }
  if (!opt.force) s.lastRun = today;
  await L.kvSet("purchase_settings", s);
  return sent;
}
exports.run = run;
exports.handler = async () => { try { const r = await run({}); return { statusCode: 200, body: JSON.stringify(r) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
