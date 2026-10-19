// Purchase & Stock planning — READ-ONLY on Tally.
// Inputs:  Tally Stock Summary (tally_stock, via Maadhu's daily backup email),
//          Tally Day Book (tally_vouchers: purchase bills → supplier, rate, receipts),
//          physical counts from Prakash/Virupaksha, production orders (production_v1) × BOM.
// Output:  what to order, by whom, how much — plus follow-ups on what was ordered.
const crypto = require("crypto");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const SITE = "https://rk-tracker-v2.netlify.app";

const USERS = ["main", "prakash", "viru"];
const NAMES = { main: "Ravi", prakash: "Prakash", viru: "Virupaksha" };
const CATS = { raw: "Raw incense material", perfume: "Perfume / oils", packing: "Boxes & packing", carton: "Outer cartons", finished: "Finished goods", other: "Other" };
const OWNER_OF = { raw: "prakash", perfume: "prakash", carton: "prakash", packing: "viru" };
const SDEF = { ownerEmail: "onamagarbathi@gmail.com", prakashEmail: "prakashonam@gmail.com", viruEmail: "onamviru@gmail.com",
  maadhuEmail: "onammadhu@gmail.com", coverDays: 15, defaultLead: 7, emailStaff: true, emailOwner: true, poSeq: 0 };

// Who orders what (Ravi, Oct 2026): Prakash — raw incense materials, perfumes, outer cartons;
// Virupaksha — boxes and packing material. Keyword guess only; every item can be changed on the page.
function classify(name) {
  const n = norm(name);
  if (/carton|corrugat|\bcfc\b|master ?box|outer/.test(n)) return "carton";
  if (/perfume|fragrance|compound|\boils?\b|attar|essential|\bdep\b|\bipm\b|solvent|chemical|aroma/.test(n)) return "perfume";
  if (/powder|charcoal|jigit|joss|wood|bamboo|gum|resin|saw ?dust|\braw\b|premix|masala|binder|guggul|benzoin|loban|camphor|halmaddi|coal/.test(n)) return "raw";
  if (/\bbox(es)?\b|pouch|wrapper|label|sleeve|sticker|cellophane|bopp|\bpoly|shrink|tray|insert|print|leaflet|bookmark|tape|foil|lamin|cover|tin\b|bottle|cap\b|zip/.test(n)) return "packing";
  if (/agarbat|incense|dhoop|cones?\b|sticks?\b|\d+\s*(g|gm|gms|gram)s?\b|\d+\s*sticks/.test(n)) return "finished";
  return "other";
}


// ---- Production read from Tally (Stock Journal / Manufacturing Journal in the Day Book XML) ----
// A voucher counts as production when it has both consumed (outward) and produced (inward) stock lines.
// Same item on both sides in equal quantity = a godown transfer, ignored.
const JOURNAL = /journal|manufactur|production|assembl/i;
function deriveProduction(vouchers) {
  const days = {}, fg = {}, entries = []; let seen = 0;
  const cut = addDays(todayIST(), -120);
  (vouchers || []).forEach((v) => {
    if (v.c || v.o || !v.i || !v.i.length || v.d < cut) return;
    if (!JOURNAL.test(v.t || "") && v.p) return;
    const out = v.i.filter((x) => x.o === 1 && x.q > 0), inn = v.i.filter((x) => x.o === 0 && x.q > 0);
    if (!out.length || !inn.length) return;
    const outM = {}; out.forEach((x) => (outM[x.i] = (outM[x.i] || 0) + x.q));
    const innM = {}; inn.forEach((x) => (innM[x.i] = (innM[x.i] || 0) + x.q));
    Object.keys(innM).forEach((k) => { if (outM[k] != null && Math.abs(outM[k] - innM[k]) < 0.5) { delete outM[k]; delete innM[k]; } });
    const prods = Object.keys(innM), mats = Object.keys(outM);
    if (!prods.length || !mats.length) return;
    seen++;
    entries.push({ d: v.d, vno: v.n || "", type: v.t || "", made: Object.assign({}, innM), used: Object.assign({}, outM) });
    const tot = prods.reduce((s, k) => s + innM[k], 0);
    const unitOf = {}; v.i.forEach((x) => { if (x.u) unitOf[x.i] = x.u; });
    prods.forEach((k) => {
      const share = innM[k] / tot, f = fg[k] = fg[k] || { item: k, unit: unitOf[k] || "", made: 0, batches: 0, last: "", use: {} };
      f.made += innM[k]; f.batches++; if (v.d > f.last) f.last = v.d;
      mats.forEach((m) => { const e = f.use[m] = f.use[m] || { q: 0, u: unitOf[m] || "" }; e.q += outM[m] * share; });
      const dd = days[v.d] = days[v.d] || {}; dd[k] = (dd[k] || 0) + innM[k];
    });
  });
  const boms = Object.keys(fg).map((k) => { const f = fg[k];
    return { item: k, unit: f.unit, made: Math.round(f.made * 100) / 100, batches: f.batches, last: f.last,
      lines: Object.keys(f.use).map((m) => ({ item: m, unit: f.use[m].u, perUnit: f.use[m].q / f.made })).sort((a, b) => b.perUnit - a.perUnit) }; })
    .sort((a, b) => (a.last < b.last ? 1 : -1));
  // materials consumed per day over the last 60 days → daily use
  const consumed = {}, since = addDays(todayIST(), -60);
  (vouchers || []).forEach((v) => { if (v.c || v.o || !v.i || v.d < since || !(JOURNAL.test(v.t || "") || !v.p)) return;
    const oM = {}, iM = {}; v.i.forEach((x) => { if (!(x.q > 0)) return; (x.o === 1 ? oM : iM)[x.i] = ((x.o === 1 ? oM : iM)[x.i] || 0) + x.q; });
    Object.keys(iM).forEach((k) => { if (oM[k] != null && Math.abs(oM[k] - iM[k]) < 0.5) { delete oM[k]; delete iM[k]; } });
    if (!Object.keys(iM).length) return;
    Object.keys(oM).forEach((k) => (consumed[k] = (consumed[k] || 0) + oM[k])); });
  const recent = Object.keys(days).sort().slice(-30).reverse().map((d) => ({ d, items: Object.keys(days[d]).map((k) => ({ item: k, qty: Math.round(days[d][k] * 100) / 100, unit: (fg[k] || {}).unit || "" })) }));
  entries.sort((a, b) => (a.d < b.d ? -1 : 1));
  return { boms, recent, consumed, entries, vouchers: seen,
    itemLevel: (vouchers || []).some((v) => v.i && v.i.length), hasOut: (vouchers || []).some((v) => v.i && v.i.some((x) => x.o === 1)) };
}
const STOP = /\b(box|boxes|pack|packs|pcs|nos|no|of|the|and|sticks?|stick|agarbat\w*|incense|case|cases|gm|gms|g)\b/g;
const toks = (s) => norm(s).replace(STOP, " ").replace(/[^a-z0-9 ]/g, " ").split(" ").filter((x) => x.length > 1);
function matchProduct(name, list, alias) {
  if (alias && alias[name] && list.indexOf(alias[name]) >= 0) return alias[name];
  const n = norm(name); let best = null, score = 0;
  list.forEach((k) => { const kn = norm(k); let s = 0;
    if (kn === n) s = 3; else if (kn.indexOf(n) >= 0 || n.indexOf(kn) >= 0) s = 2;
    else { const a = toks(name), b = toks(k); if (a.length && b.length) { const c = a.filter((x) => b.indexOf(x) >= 0).length; const f = c / Math.max(a.length, b.length); if (f >= 0.6) s = 1 + f / 2; } }
    if (s > score) { score = s; best = k; } });
  return best;
}


// ---- Fill the Production page from Tally: each journal that produced a linked finished item becomes a log
// on the oldest open production order for that product (cases = Tally qty ÷ units per case). Never double-counts a voucher.
function syncProduction(D) {
  const pt = D.pt || {}, added = [];
  (pt.entries || []).forEach((e) => {
    Object.keys(e.made).forEach((fg) => {
      const upc = +D.units[fg] || 0; if (!upc) return;
      const key = e.d + "|" + e.vno + "|" + fg;
      if (D.prod.some((o) => (o.logs || []).some((l) => l.tallyKey === key))) return;
      const open = D.prod.filter((o) => {
        const made = (o.logs || []).reduce((s, l) => s + (+l.qty || 0), 0);
        return made < (+o.targetCases || 0) && (!o.startDate || o.startDate <= e.d) && matchProduct(o.product || "", [fg], D.alias) === fg;
      }).sort((a, b) => ((a.promisedDate || "9") < (b.promisedDate || "9") ? -1 : 1));
      let cases = Math.round(e.made[fg] / upc * 100) / 100;
      for (const o of open) { if (cases <= 0) break;
        const made = (o.logs || []).reduce((s, l) => s + (+l.qty || 0), 0), bal = (+o.targetCases || 0) - made;
        const q = Math.min(bal, cases); if (q <= 0) continue;
        o.logs = (o.logs || []).concat({ d: e.d, qty: Math.round(q * 100) / 100, note: "From Tally " + (e.type || "") + " " + e.vno, src: "tally", tallyKey: key });
        added.push({ d: e.d, order: o.customer || o.product, cases: q, fg }); cases -= q; }
    });
  });
  return added;
}
// ---- Production report: yesterday's output, open orders at risk, unusual material use
function productionReport(D) {
  const pt = D.pt || {}, today = todayIST(), E = pt.entries || [];
  const lastDay = E.length ? E[E.length - 1].d : null;
  const day = lastDay ? E.filter((e) => e.d === lastDay) : [];
  const madeDay = {}; day.forEach((e) => Object.keys(e.made).forEach((k) => (madeDay[k] = (madeDay[k] || 0) + e.made[k])));
  const unitOf = {}; (pt.boms || []).forEach((b) => (unitOf[b.item] = b.unit));
  const output = Object.keys(madeDay).map((k) => ({ item: k, qty: madeDay[k], unit: unitOf[k] || "", cases: D.units[k] ? Math.round(madeDay[k] / D.units[k] * 10) / 10 : null }));
  // open orders: needed per day vs last-7-days pace
  const orders = D.prod.map((o) => {
    const logs = o.logs || [], made = logs.reduce((s, l) => s + (+l.qty || 0), 0), target = +o.targetCases || 0, bal = Math.max(0, target - made);
    if (!bal) return null;
    const since = addDays(today, -7), pace = logs.filter((l) => l.d >= since).reduce((s, l) => s + (+l.qty || 0), 0) / 7;
    const left = o.promisedDate ? Math.max(1, daysBetween(today, o.promisedDate)) : null;
    const need = left ? bal / left : null;
    const risk = o.promisedDate && (o.promisedDate < today || (need && pace < need * 0.9));
    return { name: o.customer || "", product: o.product || "", made, target, bal, promised: o.promisedDate || "", need: need ? Math.round(need * 10) / 10 : null, pace: Math.round(pace * 10) / 10, risk: !!risk };
  }).filter(Boolean).sort((a, b) => (b.risk - a.risk) || ((a.promised || "9") < (b.promised || "9") ? -1 : 1));
  // material variance: a batch in the last 7 days using >15% more per unit than this product's average
  const avg = {}; (pt.boms || []).forEach((b) => { if (b.batches >= 3) b.lines.forEach((l) => (avg[b.item + "|" + l.item] = l.perUnit)); });
  const variance = [], since7 = addDays(today, -7);
  E.filter((e) => e.d >= since7).forEach((e) => { const fgs = Object.keys(e.made); if (fgs.length !== 1) return; const fg = fgs[0], q = e.made[fg];
    Object.keys(e.used).forEach((m) => { const a = avg[fg + "|" + m]; if (!a) return; const per = e.used[m] / q;
      if (per > a * 1.15) variance.push({ d: e.d, vno: e.vno, fg, item: m, per, avg: a, pct: Math.round((per / a - 1) * 100) }); }); });
  return { lastDay, output, orders, variance: variance.sort((a, b) => b.pct - a.pct).slice(0, 15) };
}


// ---- Purchase intelligence from Tally purchase vouchers (Day Book XML item lines) + Payables export ----
// Rate = item amount ÷ quantity as Tally records it (before tax). Nothing here writes to Tally.
function purchaseIntel(D, payRows) {
  const today = todayIST();
  const bills = (D.vouchers || []).filter((v) => !v.c && /purchase/i.test(v.t || "") && !/order|return|debit/i.test(v.t || "") && v.i && v.i.length)
    .map((v) => ({ d: v.d, n: v.n || "", p: v.p || "", total: v.a || 0,
      items: v.i.filter((x) => x.q > 0 && x.a > 0).map((x) => ({ i: x.i, q: x.q, u: x.u || "", a: x.a, rate: Math.round(x.a / x.q * 100) / 100 })) }))
    .filter((b) => b.items.length).sort((a, b) => (a.d < b.d ? -1 : 1));
  const catOf = (name) => (D.items[name] && D.items[name].cat) || classify(name);
  const items = {};
  bills.forEach((b) => b.items.forEach((x) => {
    const it = items[x.i] = items[x.i] || { item: x.i, cat: catOf(x.i), unit: x.u, history: [], suppliers: {} };
    it.history.push({ d: b.d, rate: x.rate, supplier: b.p, q: x.q, vno: b.n });
    const s = it.suppliers[b.p] = it.suppliers[b.p] || { supplier: b.p, lastRate: 0, lastDate: "", qty: 0, spend: 0 };
    s.lastRate = x.rate; s.lastDate = b.d; s.qty += x.q; s.spend += x.a;
  }));
  const since90 = addDays(today, -90), since30 = addDays(today, -30);
  const list = Object.values(items).map((it) => {
    const h = it.history, last = h[h.length - 1], prev = h.length > 1 ? h[h.length - 2] : null;
    const h90 = h.filter((x) => x.d >= since90);
    const avg90 = h90.length ? h90.reduce((s, x) => s + x.rate * x.q, 0) / h90.reduce((s, x) => s + x.q, 0) : null;
    const sup = Object.values(it.suppliers).filter((s) => s.lastDate >= addDays(today, -365)).sort((a, b) => a.lastRate - b.lastRate);
    return { item: it.item, cat: it.cat, unit: it.unit, lastRate: last.rate, lastDate: last.d, lastSupplier: last.supplier, prevRate: prev ? prev.rate : null,
      change: prev && prev.rate ? Math.round((last.rate / prev.rate - 1) * 1000) / 10 : null, avg90: avg90 ? Math.round(avg90 * 100) / 100 : null,
      best: sup.length > 1 ? { supplier: sup[0].supplier, rate: sup[0].lastRate } : null, buys: h.length, history: h.slice(-24), suppliers: sup.length };
  }).sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
  // >10% jump on the latest purchase vs the one before, within the last 30 days
  const jumps = list.filter((x) => x.change != null && x.change > 10 && x.lastDate >= since30)
    .map((x) => ({ item: x.item, cat: x.cat, unit: x.unit, rate: x.lastRate, prev: x.prevRate, change: x.change, supplier: x.lastSupplier, d: x.lastDate, best: x.best }))
    .sort((a, b) => b.change - a.change);
  // spend
  const byMonth = {}; bills.forEach((b) => { const m = b.d.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + b.items.reduce((s, x) => s + x.a, 0); });
  const months = Object.keys(byMonth).sort().slice(-12).map((m) => ({ m, amt: Math.round(byMonth[m]) }));
  const spendBy = (from, key) => { const o = {}; bills.filter((b) => b.d >= from).forEach((b) => b.items.forEach((x) => { const k = key(b, x); o[k] = (o[k] || 0) + x.a; }));
    return Object.keys(o).map((k) => ({ k, amt: Math.round(o[k]) })).sort((a, b) => b.amt - a.amt); };
  const byCat90 = spendBy(since90, (b, x) => CATS[catOf(x.i)] || "Other");
  const bySup90 = spendBy(since90, (b) => b.p || "(no supplier)").slice(0, 15);
  // payables: amounts we owe (positive), not CSD/customer debit balances
  const pr = (payRows || []).filter((r) => r && r.amt > 0 && !/canteen\s*stores|\bcsd\b/i.test(r.party || ""));
  const pay = {}; pr.forEach((r) => { const p = pay[r.party] = pay[r.party] || { party: r.party, amt: 0, overdue: 0, bills: 0, oldest: 0 };
    p.amt += r.amt; p.bills++; if ((r.over || 0) > 0) { p.overdue += r.amt; p.oldest = Math.max(p.oldest, r.over); } });
  const payables = Object.values(pay).sort((a, b) => b.overdue - a.overdue || b.amt - a.amt).slice(0, 25)
    .map((p) => ({ party: p.party, amt: Math.round(p.amt), overdue: Math.round(p.overdue), bills: p.bills, oldest: p.oldest }));
  const dueSoon = pr.filter((r) => r.due && r.due >= today && r.due <= addDays(today, 15)).reduce((s, r) => s + r.amt, 0);
  return { hasData: bills.length > 0, billCount: bills.length, from: bills.length ? bills[0].d : null, to: bills.length ? bills[bills.length - 1].d : null,
    items: list.slice(0, 150), jumps, months, byCat90, bySup90, payables, payTotal: Math.round(pr.reduce((s, r) => s + r.amt, 0)),
    payOverdue: Math.round(pr.filter((r) => (r.over || 0) > 0).reduce((s, r) => s + r.amt, 0)), dueSoon: Math.round(dueSoon), bills: bills.slice(-60).reverse() };
}

// consumption recorded by inventory scans (issued − returned) over the last 60 days, per day
async function scanConsumption() {
  const lots = (await kvGet("inv_lots")) || []; if (!lots.length) return {};
  const from = addDays(todayIST(), -60), c = {};
  lots.forEach((l) => (l.ev || []).forEach((e) => { if (e.d < from) return; if (e.t === "issue") c[l.item] = (c[l.item] || 0) + e.q; if (e.t === "return") c[l.item] = (c[l.item] || 0) - e.q; }));
  Object.keys(c).forEach((k) => (c[k] = Math.max(0, c[k]) / 60)); return c;
}
async function settings() { return Object.assign({}, SDEF, (await kvGet("purchase_settings")) || {}); }

async function checkPin(user, pin) {
  user = String(user || "").toLowerCase();
  if (USERS.indexOf(user) < 0) return null;
  const pins = (await kvGet("user_pins")) || {};
  return pins[user] && pins[user] === hash(String(pin || "")) ? user : null;
}

// Keep one stock snapshot per day (written whenever a Stock Summary is ingested).
async function recordStock(rows, asof) {
  if (!rows || !rows.length) return;
  const d = asof || todayIST();
  const hist = (await kvGet("purchase_stock_hist")) || [];
  const q = {}; rows.forEach((r) => { if (r && r.item) q[r.item] = r.qty || 0; });
  const rest = hist.filter((h) => h.d !== d);
  rest.push({ d, q });
  rest.sort((a, b) => (a.d < b.d ? -1 : 1));
  await kvSet("purchase_stock_hist", rest.slice(-150));
}

// Average daily use = sum of the drops between snapshots ÷ days covered (last 60 days).
// Rises (purchases received) are ignored, so a delivery never looks like negative use.
function usage(hist, name) {
  const pts = hist.filter((h) => h.q && h.q[name] != null);
  if (pts.length < 2) return 0;
  const from = addDays(pts[pts.length - 1].d, -60);
  const w = pts.filter((p) => p.d >= from);
  if (w.length < 2) return 0;
  const span = daysBetween(w[0].d, w[w.length - 1].d);
  if (span < 3) return 0;
  let drop = 0;
  for (let i = 1; i < w.length; i++) { const dlt = w[i].q[name] - w[i - 1].q[name]; if (dlt < 0) drop += -dlt; }
  return drop / span;
}

function lastPurchase(vouchers, name) {
  const n = norm(name);
  for (let i = vouchers.length - 1; i >= 0; i--) {
    const v = vouchers[i];
    if (v.c || !/purchase/i.test(v.t || "") || !v.i) continue;
    const it = v.i.find((x) => norm(x.i) === n);
    if (it) return { d: v.d, supplier: v.p, qty: it.q, rate: it.q ? Math.round(it.a / it.q * 100) / 100 : 0, vno: v.n };
  }
  return null;
}

async function load() {
  const [s, items, counts, hist, boms, pos, stock, vch, prod, snooze, units, alias] = await Promise.all([
    settings(), kvGet("purchase_items"), kvGet("purchase_counts"), kvGet("purchase_stock_hist"), kvGet("purchase_boms"),
    kvGet("purchase_pos"), kvGet("tally_stock"), kvGet("tally_vouchers"), kvGet("production_v1"), kvGet("purchase_snooze"),
    kvGet("purchase_units"), kvGet("purchase_alias")]);
  const vouchers = (vch && vch.list) || [];
  return { s, items: items || {}, counts: counts || {}, hist: hist || [], boms: boms || {}, pos: (pos && pos.list) ? pos : { list: [] },
    stock: stock || { rows: [] }, vouchers, prod: (prod && prod.orders) || [], snooze: snooze || {},
    units: units || {}, alias: alias || {}, pt: deriveProduction(vouchers), scanUse: await scanConsumption() };
}

// Purchase bills in the Day Book close orders automatically.
function autoReceive(D) {
  let changed = false;
  D.pos.list.forEach((p) => {
    if (p.status !== "ordered") return;
    const n = norm(p.item);
    D.vouchers.forEach((v) => {
      if (v.c || !/purchase/i.test(v.t || "") || !v.i || v.d < p.orderedOn) return;
      const key = [v.d, v.n, v.p].join("|");
      if ((p.bills || []).indexOf(key) >= 0) return;
      const it = v.i.find((x) => norm(x.i) === n); if (!it) return;
      p.bills = (p.bills || []).concat(key);
      p.receivedQty = (p.receivedQty || 0) + (it.q || 0);
      p.receivedOn = v.d; p.bill = (v.n || "") + " · " + (v.p || ""); changed = true;
    });
    if ((p.receivedQty || 0) >= 0.9 * (p.orderedQty || p.qty || 0) && (p.receivedQty || 0) > 0) { p.status = "received"; p.autoReceived = true; changed = true; }
  });
  return changed;
}

function plan(D) {
  const today = todayIST(), s = D.s;
  const stockRows = D.stock.rows || [], asof = D.stock.asof || (D.stock.at || "").slice(0, 10) || null;
  const names = new Set(stockRows.map((r) => r.item));
  Object.keys(D.items).forEach((k) => names.add(k));
  Object.keys(D.counts).forEach((k) => names.add(k));
  // production need: balance cases × BOM per case
  const bomBy = {}; Object.keys(D.boms).forEach((k) => (bomBy[norm(k)] = D.boms[k]));
  const autoBy = {}; ((D.pt && D.pt.boms) || []).forEach((b) => (autoBy[b.item] = b));
  const setup = [];      // production products whose BOM exists in Tally but units-per-case isn't set
  const prodNeed = {}, prodFor = {};
  D.prod.forEach((o) => {
    const made = (o.logs || []).reduce((t, l) => t + (+l.qty || 0), 0);
    const bal = Math.max(0, (+o.targetCases || 0) - made); if (!bal) return;
    let lines = bomBy[norm(o.product)];            // 1) BOM typed by Ravi wins
    if (!lines) {                                   // 2) BOM learned from Virupaksha's Tally entries
      const fgKey = matchProduct(o.product || "", Object.keys(autoBy), D.alias);
      if (!fgKey) { setup.push({ product: o.product, why: "no matching finished item in Tally production yet", cases: bal }); return; }
      const upc = +D.units[fgKey] || 0;
      if (!upc) { setup.push({ product: o.product, fg: fgKey, why: "set units per case", cases: bal }); return; }
      lines = autoBy[fgKey].lines.map((l) => ({ item: l.item, perCase: l.perUnit * upc }));
    }
    lines.forEach((l) => { if (!l.item) return; names.add(l.item);
      prodNeed[l.item] = (prodNeed[l.item] || 0) + bal * (+l.perCase || 0);
      (prodFor[l.item] = prodFor[l.item] || []).push((o.customer || o.product) + " (" + bal + " cs)"); });
  });
  const onOrder = {};
  D.pos.list.forEach((p) => { if (p.status === "ordered") onOrder[p.item] = (onOrder[p.item] || 0) + Math.max(0, (p.orderedQty || p.qty || 0) - (p.receivedQty || 0)); });
  const out = [];
  names.forEach((name) => {
    const cfg = D.items[name] || {};
    const cat = cfg.cat || classify(name);
    const owner = cfg.owner != null ? cfg.owner : (OWNER_OF[cat] || "");
    const track = cfg.track != null ? cfg.track : !!OWNER_OF[cat];
    const tr = stockRows.find((r) => r.item === name);
    const cnt = D.counts[name];
    let qty = tr ? tr.qty : null, src = tr ? "Tally " + (asof || "") : "", unit = cfg.unit || (tr && tr.unit) || "";
    if (cnt && (!tr || !asof || cnt.d >= asof)) { qty = cnt.qty; src = "Count by " + (NAMES[cnt.by] || cnt.by) + " " + cnt.d; }
    const consDay = D.pt && D.pt.consumed && D.pt.consumed[name] ? D.pt.consumed[name] / 60 : 0;
    const scanDay = D.scanUse && D.scanUse[name] ? D.scanUse[name] : 0;
    const use = consDay > 0 ? consDay : scanDay > 0 ? scanDay : usage(D.hist, name);   // Tally journals, then gate/store scans, then stock drops   // real consumption from Tally journals beats stock-drop guesses
    const lead = +cfg.leadDays || s.defaultLead, cover = s.coverDays;
    const min = +cfg.min || 0, need = prodNeed[name] || 0, oo = onOrder[name] || 0;
    const lp = lastPurchase(D.vouchers, name);
    const row = { item: name, cat, owner, track, unit, qty, src, use: Math.round(use * 100) / 100,
      daysLeft: use > 0 && qty != null ? Math.floor(qty / use) : null, min, lead, prodNeed: need, prodFor: prodFor[name] || [],
      onOrder: oo, supplier: cfg.supplier || (lp && lp.supplier) || "", lastPurchase: lp, reorderQty: +cfg.reorderQty || 0, note: cfg.note || "" };
    if (track && owner && qty != null) {
      const have = qty + oo;
      const point = Math.max(min, use * lead) + need;
      const target = Math.max(min, Math.ceil(use * (lead + cover))) + need;
      const snoozed = D.snooze[name] && D.snooze[name] >= today;
      if (have < point && !snoozed && (point > 0)) {
        row.order = Math.max(row.reorderQty, Math.ceil(target - have));
        const why = [];
        if (need > 0) why.push("production needs " + Math.round(need) + " " + unit);
        if (row.daysLeft != null && row.daysLeft <= lead) why.push("only ~" + row.daysLeft + " days left, supplier takes ~" + lead);
        if (min && qty < min) why.push("below minimum " + min);
        if (!why.length) why.push("below reorder level");
        row.why = why.join("; ");
      }
    }
    out.push(row);
  });
  out.sort((a, b) => (b.order ? 1 : 0) - (a.order ? 1 : 0) || (a.daysLeft == null ? 1e9 : a.daysLeft) - (b.daysLeft == null ? 1e9 : b.daysLeft) || a.item.localeCompare(b.item));
  const overdue = D.pos.list.filter((p) => p.status === "ordered" && p.expected && p.expected < today);
  return { today, asof, stale: asof ? daysBetween(asof, today) : null, rows: out, overdue, setup, hasStock: stockRows.length > 0 };
}

// Turn today's suggestions into PO lines (status "suggested"), keeping ids stable per item.
function syncSuggestions(D, P) {
  const keep = D.pos.list.filter((p) => p.status !== "suggested");
  const old = {}; D.pos.list.filter((p) => p.status === "suggested").forEach((p) => (old[p.item] = p));
  P.rows.filter((r) => r.order).forEach((r) => {
    const o = old[r.item] || { id: "po_" + crypto.randomBytes(5).toString("hex"), created: P.today };
    keep.push(Object.assign(o, { item: r.item, owner: r.owner, cat: r.cat, qty: r.order, unit: r.unit, supplier: r.supplier, why: r.why, status: "suggested" }));
  });
  // keep finished history for 120 days
  const cut = addDays(P.today, -120);
  D.pos.list = keep.filter((p) => p.status === "suggested" || p.status === "ordered" || (p.receivedOn || p.cancelledOn || p.created || P.today) >= cut);
}

module.exports = { purchaseIntel, deriveProduction, matchProduct, syncProduction, productionReport, kvGet, kvSet, hash, todayIST, addDays, daysBetween, norm, classify, settings, checkPin, recordStock, load, plan, autoReceive,
  syncSuggestions, USERS, NAMES, CATS, OWNER_OF, SITE };
