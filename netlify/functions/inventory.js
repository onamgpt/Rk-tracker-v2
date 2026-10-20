// Scan-based inventory. Every package (bag, box, drum, bundle) gets its own QR label at the gate.
// Inward: security (all materials). Issue / return / fully used, by category:
//   raw incense material → security · packing & cartons → Virupaksha · perfume & chemicals → Prakash · Ravi: everything.
// Issue = consumed. A return puts the remaining weight/count back in store; a drum is closed with "fully used".
const crypto = require("crypto");
const L = require("./purchase-lib.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const USERS = ["gate", "viru", "prakash", "main"];
const NAMES = { gate: "Security", viru: "Virupaksha", prakash: "Prakash", main: "Ravi" };
const ISSUER = { raw: "gate", packing: "viru", carton: "viru", perfume: "prakash" };
const DEPT = { raw: "Agarbathi making", packing: "Packing", carton: "Packing", perfume: "Perfuming", other: "Production", finished: "Dispatch" };
const nowIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(11, 16);
const num = (x) => { const n = parseFloat(String(x == null ? "" : x).replace(/,/g, "")); return isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 1000) / 1000;
const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n || 120);

function canAct(user, lot) { if (lot.status === "expected") return user === "gate" || user === "main"; return user === "main" || ISSUER[lot.cat] === user || (!ISSUER[lot.cat] && user === "main"); }

// ---- pure state changes (tested) ----
function inward(lots, p, by, day, ts) {
  const out = [];
  for (let i = 0; i < p.packages; i++) {
    const lot = { id: "lt_" + crypto.randomBytes(5).toString("hex"), token: crypto.randomBytes(9).toString("base64url"), item: p.item, cat: p.cat, unit: p.unit,
      qty: p.per, orig: p.per, supplier: p.supplier, bill: p.bill, recvd: day, no: i + 1, of: p.packages, status: "store", ev: [{ t: "in", d: day, ts, by, q: p.per }] };
    lots.push(lot); out.push(lot);
  }
  return out;
}
function act(lot, action, q, by, day, ts) {
  if (action === "receive") { if (lot.status !== "expected") return "Already received"; lot.status = "store"; lot.recvd = day; lot.ev.push({ t: "in", d: day, ts, by, q: lot.qty }); return null; }
  if (action === "issue") { if (lot.status !== "store") return "Not in store (" + lot.status + ")"; lot.status = "issued"; lot.dept = DEPT[lot.cat] || "Production"; lot.ev.push({ t: "issue", d: day, ts, by, q: lot.qty }); return null; }
  if (action === "return") { if (lot.status !== "issued") return "Only an issued package can be returned"; const r = Math.max(0, Math.min(q, lot.qty)); if (!r) return "Enter the quantity left";
    lot.ev.push({ t: "return", d: day, ts, by, q: r }); lot.qty = r2(r); lot.status = "store"; lot.dept = ""; return null; }
  if (action === "used") { if (lot.status !== "issued") return "Only an issued package can be closed"; lot.status = "used"; lot.ev.push({ t: "used", d: day, ts, by, q: 0 }); return null; }
  return "unknown action";
}
// consumed quantity per item between two dates = issued − returned
function consumption(lots, from, to) {
  const c = {}; lots.forEach((l) => l.ev.forEach((e) => { if (e.d < from || e.d > to) return;
    if (e.t === "issue") c[l.item] = (c[l.item] || 0) + e.q; if (e.t === "return") c[l.item] = (c[l.item] || 0) - e.q; }));
  Object.keys(c).forEach((k) => (c[k] = r2(c[k]))); return c;
}
function stock(lots) {
  const s = {};
  lots.forEach((l) => { if (l.status === "used" || l.status === "expected") return;
    const e = s[l.item] = s[l.item] || { item: l.item, cat: l.cat, unit: l.unit, store: 0, storePk: 0, dept: 0, deptPk: 0 };
    if (l.status === "store") { e.store += l.qty; e.storePk++; } else { e.dept += l.qty; e.deptPk++; } });
  return Object.values(s).map((e) => Object.assign(e, { store: r2(e.store), dept: r2(e.dept) })).sort((a, b) => a.item.localeCompare(b.item));
}
// keep the working list small: closed packages whose last event is over 60 days old move to a monthly archive
async function save(lots) {
  const cut = L.addDays(L.todayIST(), -60), keep = [], arch = {};
  lots.forEach((l) => { const last = l.ev[l.ev.length - 1].d;
    if (l.status === "used" && last < cut) (arch[last.slice(0, 7)] = arch[last.slice(0, 7)] || []).push(l); else keep.push(l); });
  for (const m of Object.keys(arch)) { const k = "inv_archive_" + m.replace("-", ""); const old = (await L.kvGet(k)) || []; await L.kvSet(k, old.concat(arch[m])); }
  await L.kvSet("inv_lots", keep);
  // live store stock feeds Purchase & Stock as the newest count
  const counts = (await L.kvGet("purchase_counts")) || {}, today = L.todayIST();
  const seen = new Set(keep.map((l) => l.item));
  stock(keep).forEach((e) => { counts[e.item] = { qty: e.store, d: today, by: "scan" }; seen.delete(e.item); });
  seen.forEach((item) => { counts[item] = { qty: 0, d: today, by: "scan" }; });
  await L.kvSet("purchase_counts", counts);
}
// close open purchase orders when the goods arrive at the gate
async function receivePO(item, qty, supplier, day) {
  const pos = (await L.kvGet("purchase_pos")) || { list: [] }; const n = L.norm(item);
  const p = (pos.list || []).filter((x) => x.status === "ordered" && L.norm(x.item) === n).sort((a, b) => (a.orderedOn < b.orderedOn ? -1 : 1))[0];
  if (!p) return null;
  p.receivedQty = (p.receivedQty || 0) + qty; p.receivedOn = day; p.scanReceived = true; if (supplier && !p.supplier) p.supplier = supplier;
  if (p.receivedQty >= 0.9 * (p.orderedQty || p.qty || 0)) p.status = "received";
  await L.kvSet("purchase_pos", pos); return p.poNo || "PO";
}
async function receivePOFor(e) { for (const ln of e.lines || []) { try { await receivePO(ln.item, ln.qty, e.supplier, L.todayIST()); } catch (x) {} } }
exports.inward = inward; exports.act = act; exports.consumption = consumption; exports.stock = stock; exports.DEPT = DEPT; exports.ISSUER = ISSUER; exports.NAMES = NAMES;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const user = String(b.user || "").toLowerCase();
  if (USERS.indexOf(user) < 0) return OK({ error: "pin" });
  const pins = (await L.kvGet("user_pins")) || {};
  if (!pins[user] || pins[user] !== L.hash(String(b.pin || ""))) return OK({ error: "pin" });
  const today = L.todayIST(), ts = Date.now();
  try {
    let lots = (await L.kvGet("inv_lots")) || [];
    if (b.action === "state") {
      const items = (await L.kvGet("purchase_items")) || {}, tst = ((await L.kvGet("tally_stock")) || {}).rows || [];
      const names = Array.from(new Set(Object.keys(items).concat(tst.map((r) => r.item)).concat(lots.map((l) => l.item)))).sort();
      const sup = Array.from(new Set(lots.map((l) => l.supplier).filter(Boolean).concat(Object.values(items).map((i) => i.supplier).filter(Boolean)))).sort();
      const todayEv = []; lots.forEach((l) => l.ev.forEach((e) => { if (e.d === today) todayEv.push({ t: e.t, at: new Date(e.ts + 5.5 * 3600e3).toISOString().slice(11, 16), by: NAMES[e.by] || e.by, item: l.item, q: e.q, unit: l.unit, no: l.no, of: l.of, supplier: l.supplier }); }));
      return OK({ ok: true, me: user, name: NAMES[user], today, names: names.slice(0, 600), suppliers: sup.slice(0, 300), cats: L.CATS, issuer: ISSUER, dept: DEPT,
        catOf: Object.fromEntries(names.map((n) => [n, (items[n] && items[n].cat) || L.classify(n)])),
        stock: stock(lots), today_ev: todayEv.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 150),
        inDept: user === "main" || user === "prakash" ? lots.filter((l) => l.status === "issued" && l.cat === "perfume").map((l) => ({ id: l.id, item: l.item, qty: l.qty, unit: l.unit, since: l.ev[l.ev.length - 1].d })) : [] });
    }
    if (b.action === "inward") {
      if (user !== "gate" && user !== "main") return OK({ error: "Inward is done by security" });
      const item = clip(b.item), per = num(b.per), packages = Math.floor(num(b.packages));
      if (!item || !(per > 0) || packages < 1 || packages > 400) return OK({ error: "Material, number of packages and quantity per package are needed" });
      const items = (await L.kvGet("purchase_items")) || {};
      const cat = L.CATS[b.cat] ? b.cat : ((items[item] && items[item].cat) || L.classify(item));
      const made = inward(lots, { item, cat, unit: clip(b.unit, 12) || "kg", per, packages, supplier: clip(b.supplier), bill: clip(b.bill, 40) }, user, today, ts);
      if (!items[item]) { items[item] = { cat, unit: clip(b.unit, 12) || "kg", track: true }; await L.kvSet("purchase_items", items); }
      await save(lots);
      const po = await receivePO(item, per * packages, clip(b.supplier), today);
      return OK({ ok: true, po, labels: made.map((l) => ({ token: l.token, item: l.item, qty: l.qty, unit: l.unit, no: l.no, of: l.of, supplier: l.supplier, bill: l.bill, recvd: l.recvd })) });
    }
    if (b.action === "scan") {
      const tok = String(b.code || "").replace(/^ONAMI:/, "").trim();
      const lot = lots.find((l) => l.token === tok);
      if (!lot) return OK({ ok: false, msg: "Label not recognised" });
      return OK({ ok: true, lot: { id: lot.id, item: lot.item, cat: lot.cat, qty: lot.qty, orig: lot.orig, unit: lot.unit, status: lot.status, no: lot.no, of: lot.of, supplier: lot.supplier, recvd: lot.recvd, dept: lot.dept || "", toDept: DEPT[lot.cat], bill: lot.bill || "", batch: lot.batch || "", expiry: lot.expiry || "" },
        can: canAct(user, lot), who: NAMES[ISSUER[lot.cat]] || "Ravi" });
    }
    if (b.action === "act") {
      const lot = lots.find((l) => l.id === b.id); if (!lot) return OK({ error: "not found" });
      if (!canAct(user, lot)) return OK({ error: (NAMES[ISSUER[lot.cat]] || "Ravi") + " handles " + (L.CATS[lot.cat] || "this material") });
      const err = act(lot, b.what, num(b.qty), user, today, ts); if (err) return OK({ error: err });
      await save(lots);
      if (b.what === "receive" && lot.expId) {
        const exps = (await L.kvGet("inv_expected")) || [], e = exps.find((x) => x.id === lot.expId);
        if (e) { const mine = lots.filter((l) => l.expId === e.id), got = mine.filter((l) => l.status !== "expected").length;
          if (!e.firstIn) { e.firstIn = today; await require("./inward.js").learnSupplier(e.supplier, null, L.daysBetween(e.billDate || e.created, today)); }
          e.received = got; e.total = mine.length; e.done = got === mine.length; await L.kvSet("inv_expected", exps);
          if (e.done && e.billNo && e.source !== "purchase order") await receivePOFor(e); }
        return OK({ ok: true, status: lot.status, qty: lot.qty, progress: e ? e.received + " of " + e.total : "" });
      }
      return OK({ ok: true, status: lot.status, qty: lot.qty });
    }
    if (b.action === "labels") {           // reprint labels for one inward (same bill + material + day)
      if (user !== "gate" && user !== "main") return OK({ error: "not allowed" });
      const sel = lots.filter((l) => l.item === b.item && l.recvd === b.recvd && (l.bill || "") === (b.bill || ""));
      return OK({ ok: true, labels: sel.map((l) => ({ token: l.token, item: l.item, qty: l.orig, unit: l.unit, no: l.no, of: l.of, supplier: l.supplier, bill: l.bill, recvd: l.recvd })) });
    }
    if (b.action === "expected") {        // deliveries billed but not fully received, labels to print
      const exps = (await L.kvGet("inv_expected")) || [], S = (await L.kvGet("inv_suppliers")) || {}, IW = require("./inward.js");
      const open = exps.filter((e) => !e.done).map((e) => { const mine = lots.filter((l) => l.expId === e.id), got = mine.filter((l) => l.status !== "expected").length;
        const due = L.addDays(e.billDate || e.created, IW.transitFor(S, e.supplier));
        return { id: e.id, supplier: e.supplier, billNo: e.billNo, billDate: e.billDate, source: e.source, printed: !!e.printed, lines: e.lines, got, total: mine.length, due, late: due < today && got < mine.length, photos: (e.photos || []).slice(-3), note: e.note }; });
      const log = ((await L.kvGet("inv_inward_log")) || []).slice(0, 5);
      return OK({ ok: true, open, suppliers: user === "main" ? Object.values(S) : [], log });
    }
    if (b.action === "expLabels") {
      if (user !== "gate" && user !== "main") return OK({ error: "not allowed" });
      const sel = lots.filter((l) => l.expId === b.id);
      if (b.done) { const exps = (await L.kvGet("inv_expected")) || [], e = exps.find((x) => x.id === b.id); if (e) { e.printed = true; await L.kvSet("inv_expected", exps); } return OK({ ok: true }); }
      return OK({ ok: true, labels: sel.map((l) => ({ token: l.token, item: l.item, qty: l.orig, unit: l.unit, no: l.no, of: l.of, supplier: l.supplier, bill: l.bill, recvd: "expected", batch: l.batch, expiry: l.expiry })) });
    }
    if (b.action === "expCancel") {
      if (user !== "main") return OK({ error: "owner only" });
      const exps = ((await L.kvGet("inv_expected")) || []).filter((x) => x.id !== b.id);
      await L.kvSet("inv_expected", exps); lots = lots.filter((l) => !(l.expId === b.id && l.status === "expected")); await save(lots); return OK({ ok: true });
    }
    if (b.action === "supplierSave") {
      if (user !== "main") return OK({ error: "owner only" });
      const S = (await L.kvGet("inv_suppliers")) || {}, k = L.norm(b.name); if (!k) return OK({ error: "name?" });
      const s = S[k] = S[k] || { name: clip(b.name), emails: [], transits: [], transitSet: 0 };
      if (b.emails != null) s.emails = String(b.emails).toLowerCase().split(/[\s,;]+/).filter((x) => /@/.test(x)).slice(0, 5);
      if (b.transit != null) s.transitSet = Math.max(0, Math.floor(num(b.transit)));
      await L.kvSet("inv_suppliers", S); return OK({ ok: true });
    }
    if (b.action === "checkNow") {
      if (user !== "main" && user !== "gate") return OK({ error: "not allowed" });
      const T = require("./tally.js"); const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
      await fetch(base + "/.netlify/functions/inward-background", { method: "POST", headers: { "x-run-key": T.runKey() }, body: "{}" }).catch(() => {});
      return OK({ ok: true });
    }
    if (b.action === "reportNow") { if (user !== "main") return OK({ error: "owner only" }); return OK({ ok: true, r: await require("./inventory-daily.js").run({ force: true }) }); }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e && e.message || e) }); }
};
