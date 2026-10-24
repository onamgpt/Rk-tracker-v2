// Every minute: turn tracker events into label prints on the Zebra, and gate scans into payroll attendance.
//  1. Dispatch — Prakash's Dispatch Register entry (carton count + invoice / "Ready") or Maadhu's invoice email
//     → carton labels "n / N" print once; a changed count (before loading) reprints the set.
//  2. Inwards  — a supplier bill read (email / WhatsApp / Telegram) or a gate "Manual inward" → package labels.
//  3. Workers  — a worker added in Payroll → gate attendance card created and its QR ID card printed.
//  4. Payroll  — gate IN/OUT scans → Payroll muster (time in/out; no scan on a working day → Absent).
//  5. Alerts   — printer not printing / Mac Mini program off / Zebra paused → WhatsApp to Ravi & Prakash.
// Everything that existed at go-live is taken as already printed (no surprise reprints).
const crypto = require("crypto");
const W = require("./wa-lib.js");
const LB = require("./label-lib.js");

const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const tok = (n) => crypto.randomBytes(n).toString("base64url");
function cartonsOf(s) {
  const q = parseInt(String(s.qty || "").replace(/[^\d]/g, ""), 10);
  if (q > 0 && q <= 500) return q;
  const m = String(s.items || "").match(/TOTAL\s+(\d+)\s*(CTN|CARTON|CASE)/i);
  return m ? +m[1] : 0;
}
const isReady = (s) => !!(String(s.invoiceNo || "").trim() || /ready/i.test(s.production || ""));
const isOff = (d, hol) => new Date(d + "T00:00:00Z").getUTCDay() === 0 || hol.has(d);

// ---- pure planner (used by the simulations too) ----
function plan(D, S0, now) {
  const S = JSON.parse(JSON.stringify(S0 || {}));
  S.loads = S.loads || {}; S.ships = S.ships || {}; S.exp = S.exp || []; S.lots = S.lots || []; S.cards = S.cards || {}; S.alerts = S.alerts || {};
  const today = now.day, out = { newLoads: [], jobs: [], gw: [], gwNew: [], muster: [], alerts: [], notes: [] };
  const ships = D.shipments || [], loads = (D.loads || []).slice(), exps = D.expected || [], lots = D.lots || [];
  const gws = D.gateWorkers || [], pws = D.payWorkers || [];

  if (!S.init) {                                   // go-live baseline
    S.init = true; S.since = today;
    loads.forEach((L) => (S.loads[L.id] = L.total || 0));
    ships.forEach((s) => { if (s.dispatchedOn) S.ships[s.id] = "base"; });
    S.exp = exps.map((e) => e.id);
    S.lots = lots.filter((l) => !l.expId).map((l) => l.id);
    gws.forEach((w) => (S.cards[w.id] = w.token));
    out.notes.push("baseline: " + loads.length + " loads, " + exps.length + " bills, " + gws.length + " cards taken as printed");
  }

  // 1. dispatch
  const dest = {};
  for (const s of ships) {
    dest[s.id] = s.destination || "";
    if (S.ships[s.id] === "base") continue;
    const N = cartonsOf(s);
    if (!loads.some((L) => L.orderId === s.id) && N > 0 && isReady(s)) {
      const L = { id: "dl_" + now.ts.toString(36) + tok(2), orderId: s.id, token: tok(10), total: N, invoice: String(s.invoiceNo || "").trim().slice(0, 40),
        orderNo: s.orderNo || "", customer: (s.customer || "").trim(), loaded: [], created: today, source: "Dispatch Register" };
      loads.push(L); out.newLoads.push(L);
    }
  }
  for (const L of loads) {
    if (!(L.total > 0) || S.loads[L.id] === L.total) continue;
    const prev = S.loads[L.id], lab = Object.assign({}, L, { dest: dest[L.orderId] || "" });
    if (prev && L.loaded && L.loaded.length) { S.loads[L.id] = L.total; out.notes.push("count changed during loading: " + L.customer); continue; }
    const msg = prev
      ? "🏷️ Carton count changed " + prev + " → " + L.total + " for " + L.customer + ". New labels printed – *throw away the old " + prev + " labels*."
      : "🏷️ " + L.total + " carton labels printed – *" + L.customer + "* · Inv " + (L.invoice || "-") + ".\nStick one on each master carton. Security scans each one at loading.";
    out.jobs.push({ kind: "carton", L: lab, notify: { to: ["prakash"], text: msg } });
    S.loads[L.id] = L.total;
  }

  // 2. inwards
  for (const e of exps) {
    if (S.exp.includes(e.id) || e.done) continue;
    const mine = lots.filter((l) => l.expId === e.id && l.status === "expected");
    if (!mine.length) continue;
    out.jobs.push({ kind: "inward", ref: e.id, title: (e.supplier || "") + " " + (e.billNo || ""), lots: mine,
      notify: { to: ["security"], text: "🏷️ " + mine.length + " inward labels printed – " + (e.supplier || "supplier") + " bill " + (e.billNo || "-") + ".\nStick one on each bag / drum / bundle and scan it when it arrives." } });
    S.exp.push(e.id);
  }
  const fresh = lots.filter((l) => !l.expId && !S.lots.includes(l.id) && l.ev && l.ev[0] && l.ev[0].t === "in" && now.ts - (l.ev[0].ts || 0) < 2 * 864e5);
  if (fresh.length) {
    out.jobs.push({ kind: "inward", ref: "manual-" + today, title: "Gate inward " + today, lots: fresh,
      notify: { to: ["security"], text: "🏷️ " + fresh.length + " labels printed for the gate inward. Stick one on each package." } });
    S.lots = S.lots.concat(fresh.map((l) => l.id));
  }
  S.exp = S.exp.slice(-1000); S.lots = S.lots.slice(-5000);

  // 3. payroll workers → gate cards
  const gwAll = gws.map((w) => Object.assign({}, w));
  for (const p of pws) {
    if (!p || !p.id || !String(p.name || "").trim()) continue;
    let g = gwAll.find((w) => w.payrollId === p.id) || gwAll.find((w) => !w.payrollId && w.name.trim().toLowerCase() === p.name.trim().toLowerCase());
    const active = p.active !== false;
    if (!g) {
      if (!active) continue;
      g = { id: "w_" + now.ts.toString(36) + tok(2), name: p.name.trim(), active: true, token: tok(12), payrollId: p.id };
      gwAll.push(g); out.gwNew.push(g);
    } else {
      const set = {};
      if (g.payrollId !== p.id) set.payrollId = p.id;
      if (g.active !== active) set.active = active;
      if (Object.keys(set).length) { Object.assign(g, set); out.gw.push({ id: g.id, set }); }
    }
  }
  const cards = gwAll.filter((w) => w.active && S.cards[w.id] !== w.token);
  if (cards.length) {
    out.jobs.push({ kind: "card", ws: cards, notify: { to: ["ravi"], text: "🪪 " + cards.length + " ID card" + (cards.length > 1 ? "s" : "") + " printed: " + cards.map((w) => w.name).join(", ") } });
    cards.forEach((w) => (S.cards[w.id] = w.token));
  }

  // 4. gate scans → payroll muster
  const hol = new Set((D.holidays || []).map((h) => h.date)), mu = D.muster || {}, scans = D.scans || [];
  const from = S.since > addDays(today, -3) ? S.since : addDays(today, -3);
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const day = scans.filter((x) => x.d === d && (x.dir === "IN" || x.dir === "OUT"));
    if (!day.length) continue;                     // gate not used that day → leave the roll alone
    const closed = d < today || now.hour >= 18;
    for (const g of gwAll) {
      if (!g.payrollId || !g.active) continue;
      const rec = (mu[d] || {})[g.payrollId] || {}, mine = day.filter((x) => x.wid === g.id);
      const set = {}, unset = [];
      if (mine.length) {
        const tin = (mine.find((x) => x.dir === "IN") || {}).t, outs = mine.filter((x) => x.dir === "OUT"), tout = outs.length ? outs[outs.length - 1].t : undefined;
        if (!rec.timeIn || rec.src === "gate") { if (tin && rec.timeIn !== tin) set.timeIn = tin; if (tout && rec.timeOut !== tout) set.timeOut = tout; }
        if (rec.status === "A" && rec.src === "gate") unset.push("status", "note");
        if (Object.keys(set).length && !rec.src) set.src = "gate";
      } else if (closed && !isOff(d, hol) && !rec.status) {
        set.status = "A"; set.note = "No gate scan"; set.src = "gate";
      }
      if (Object.keys(set).length || unset.length) out.muster.push({ d, pid: g.payrollId, name: g.name, set, unset });
    }
  }

  // 5. alerts (once an hour each)
  const ag = D.agent || {}, pend = D.pending || [], seenAgo = ag.lastSeen ? (now.ts - Date.parse(ag.lastSeen)) / 60e3 : 1e9;
  const oldest = pend.length ? (now.ts - Date.parse(pend[0].created_at)) / 60e3 : 0;
  const work = now.hour >= 10 && now.hour < 18 && now.dow !== 0;
  const alert = (k, text) => { if (!S.alerts[k] || now.ts - S.alerts[k] > 3600e3) { S.alerts[k] = now.ts; out.alerts.push({ k, to: ["ravi", "prakash"], text }); } };
  if (pend.length && seenAgo < 3 && !ag.printer) alert("noprinter", "⚠️ *Label printer not found* on the Mac Mini – " + pend.length + " label job(s) waiting.\nCheck the Zebra is switched on and its USB cable is in the Mac Mini.");
  else if (pend.length && seenAgo < 3 && /disabled|paused|stopped/i.test(ag.state || "")) alert("paused", "⚠️ *Label printer is paused* on the Mac Mini – " + pend.length + " job(s) waiting.\nOn the Mac Mini: System Settings → Printers & Scanners → Zebra → Open Print Queue → Resume.");
  else if (pend.length && seenAgo < 3 && oldest > 5) alert("stuck", "⚠️ *Labels not printing* – " + pend.length + " job(s) waiting over 5 min (" + pend[0].title + ").\nCheck the Zebra for labels, ribbon or a red light.");
  if (pend.length && work && ag.lastSeen && seenAgo > 15) alert("agent", "⚠️ *Label program not running* – the Mac Mini hasn't checked in for " + (seenAgo > 600 ? "a long time" : Math.round(seenAgo) + " min") + ", " + pend.length + " label job(s) waiting.\nSwitch on the Mac Mini / check it is awake.");
  return { S, out, loads };
}

async function apply(r, D) {
  const o = r.out, done = [];
  if (o.newLoads.length) {                         // re-read so a scan made a moment ago isn't lost
    const fresh = (await W.kvGet("dispatch_loads")) || [];
    o.newLoads.forEach((L) => { if (!fresh.some((x) => x.orderId === L.orderId)) fresh.push(L); });
    await W.kvSet("dispatch_loads", fresh); done.push("loads+" + o.newLoads.length);
  }
  if (o.gwNew.length || o.gw.length) {
    const fresh = (await W.kvGet("gate_workers")) || [];
    o.gw.forEach((p) => { const w = fresh.find((x) => x.id === p.id); if (w) Object.assign(w, p.set); });
    o.gwNew.forEach((w) => { if (!fresh.some((x) => x.payrollId === w.payrollId)) fresh.push(w); });
    await W.kvSet("gate_workers", fresh); done.push("workers+" + o.gwNew.length);
  }
  if (o.muster.length) {
    const mu = (await W.kvGet("payroll_muster")) || {};
    o.muster.forEach((m) => { const day = mu[m.d] = mu[m.d] || {}; const rec = Object.assign({}, day[m.pid] || {}, m.set); m.unset.forEach((k) => delete rec[k]); day[m.pid] = rec; });
    await W.kvSet("payroll_muster", mu); done.push("muster " + o.muster.length);
  }
  for (const j of o.jobs) {
    if (j.kind === "carton") await LB.queueCartons(j.L, j.notify);
    else if (j.kind === "inward") await LB.queueInward(j.ref, j.title, j.lots, j.notify);
    else if (j.kind === "card") await LB.queue("card", j.ws.map((w) => w.id).join(",").slice(0, 200), "ID cards (" + j.ws.length + ")", j.ws.map(LB.cardZpl), j.notify);
  }
  if (o.jobs.length) done.push("jobs " + o.jobs.length);
  for (const a of o.alerts) await W.send(a.to, a.text, { kind: "label" });
  r.S.last = { at: new Date().toISOString(), done, notes: o.notes };
  await W.kvSet("label_state", r.S);
  return done;
}

async function load() {
  const keys = ["logistics_v2", "dispatch_loads", "inv_expected", "inv_lots", "gate_workers", "gate_scans", "payroll_workers", "payroll_muster", "payroll_holidays", "label_agent", "label_state"];
  const rows = (await W.sb("GET", "/rest/v1/kv?owner=eq.main&k=in.(" + keys.map((k) => "pf_" + k).join(",") + ")&select=k,v")) || [];
  const K = {}; rows.forEach((r) => (K[r.k.slice(3)] = r.v));
  const pending = (await W.sb("GET", "/rest/v1/label_jobs?status=eq.pending&select=id,title,created_at&order=id.asc&limit=20")) || [];
  return { D: { shipments: (K.logistics_v2 || {}).shipments || [], loads: K.dispatch_loads || [], expected: K.inv_expected || [], lots: K.inv_lots || [],
    gateWorkers: K.gate_workers || [], scans: K.gate_scans || [], payWorkers: Array.isArray(K.payroll_workers) ? K.payroll_workers : [],
    muster: K.payroll_muster || {}, holidays: K.payroll_holidays || [], agent: K.label_agent || {}, pending }, S: K.label_state || {} };
}
function nowObj() { const n = W.istNow(); return { ts: Date.now(), day: n.toISOString().slice(0, 10), hour: n.getUTCHours() + n.getUTCMinutes() / 60, dow: n.getUTCDay() }; }

exports.plan = plan; exports.cartonsOf = cartonsOf;
exports.handler = async () => {
  try {
    const { D, S } = await load();
    const r = plan(D, S, nowObj());
    const done = await apply(r, D);
    return { statusCode: 200, body: JSON.stringify({ ok: true, done, notes: r.out.notes }) };
  } catch (e) { return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(e && e.message || e) }) }; }
};
