// 09:25 IST daily (Mon–Sat): queues one plain-text work sheet each for Ravi, Prakash,
// Virupaksha and Maadhu to print-queue.js, so the Mac Mini prints them by 9:45.
// Reuses the same data already computed for the morning emails — no new sources.
const L = require("./purchase-lib.js");
const D = require("./dispatch.js");
const T = require("./tally.js");

const fmt = (n) => (n == null ? "" : (Math.round(n * 100) / 100).toLocaleString("en-IN"));
const line = (s) => (s || "").toString();
const WIDTH = 60;
const rule = "-".repeat(WIDTH);
const rule2 = "=".repeat(WIDTH);

function header(name, today) {
  return rule2 + "\nONAM AGARBATHI - DAILY WORK SHEET\n" + rule2 +
    "\nName:  " + name + "\nDate:  " + today + "\nReturn sheet by 6 pm\n" + rule + "\n\n";
}
function footer() {
  return "\n" + rule +
    "\nWrite anything blocked or not done above.\n" +
    "Reply to today's email with \"done\" or a photo of\nthis sheet.\n" + rule2 + "\n";
}
function taskBlock(text) {
  return "[ ]  " + text.replace(/\n/g, "\n     ") +
    "\n     Done at: _______   Comment: ______________________\n\n";
}

async function queue(person, text) {
  const site = (process.env.URL || "https://rk-tracker-v2.netlify.app").replace(/\/$/, "");
  try {
    await fetch(site + "/.netlify/functions/print-queue", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", person, text })
    });
    return true;
  } catch (e) { return false; }
}

async function run(opt) {
  opt = opt || {};
  const today = D.todayIST();
  const DD = await L.load();
  const P = L.plan(DD);
  const loads = await D.loadLoads();
  const open = loads.filter((x) => x.total && x.loaded.length < x.total);

  // ---- Prakash: order list (raw/perfume/carton) + open dispatch loads ----
  const prItems = (P.suggest || []).filter((r) => r.owner === "prakash");
  let prBody = "";
  prItems.forEach((r) => prBody += taskBlock("Order " + fmt(r.qty) + " " + (r.unit || "") + " " + r.item + (r.supplier ? " from " + r.supplier : "")));
  open.forEach((o) => prBody += taskBlock("Load " + (o.total - o.loaded.length) + " more cartons, order " + (o.orderNo || "") + " (" + (o.customer || "") + ")"));
  if (!prBody) prBody = taskBlock("Nothing pending today — check the tracker for anything new.");
  const prakashSheet = header("Prakash", today) + prBody + footer();

  // ---- Virupaksha: packing/box orders + production ----
  const vrItems = (P.suggest || []).filter((r) => r.owner === "viru");
  let vrBody = "";
  vrItems.forEach((r) => vrBody += taskBlock("Order " + fmt(r.qty) + " " + (r.unit || "") + " " + r.item + (r.supplier ? " from " + r.supplier : "")));
  vrBody += taskBlock("Enter today's production in Tally before end of day.");
  if (!vrItems.length) vrBody = taskBlock("Nothing to order today.") + vrBody;
  const viruSheet = header("Virupaksha", today) + vrBody + footer();

  // ---- Maadhu: missing Tally documents ----
  let maBody = "";
  try {
    const s = await T.settings();
    const call = async (b) => { const db = require("./db.js"); return JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}"); };
    const meta = ((await call({ action: "getPortfolio", user: "main", key: "tally_meta" })).data) || {};
    const now = new Date(Date.now() + 5.5 * 3600e3);
    const age = (iso) => iso ? Math.floor((now - new Date(new Date(iso).getTime() + 5.5 * 3600e3)) / 864e5) : null;
    const DOCS = [["vouchers", "Day Book"], ["tb", "Trial Balance"], ["recv", "Receivables"], ["pay", "Payables"], ["stock", "Stock Summary"]];
    DOCS.forEach(([k, label]) => {
      const a2 = age(meta[k] && meta[k].at);
      if (a2 == null || a2 >= 3) maBody += taskBlock("Send " + label + (a2 == null ? " (never received)" : " (last " + a2 + " days ago)"));
    });
  } catch (e) {}
  if (!maBody) maBody = taskBlock("All Tally documents are up to date. No action needed.");
  const maadhuSheet = header("Maadhu", today) + maBody + footer();

  const sheets = [["Prakash", prakashSheet], ["Virupaksha", viruSheet], ["Maadhu", maadhuSheet]];
  const sent = [];
  for (const [person, text] of sheets) { if (await queue(person, text)) sent.push(person); }
  return { queued: sent };
}
exports.run = run;
exports.handler = async () => { try { return { statusCode: 200, body: JSON.stringify(await run({})) }; } catch (e) { return { statusCode: 200, body: String(e) }; } };
