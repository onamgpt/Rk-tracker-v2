// Purchase & Stock page API. Users: main (Ravi), prakash, viru. Never writes to Tally.
const L = require("./purchase-lib.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const num = (x) => { const n = parseFloat(String(x == null ? "" : x).replace(/,/g, "")); return isFinite(n) ? n : 0; };
const clip = (s, n) => String(s == null ? "" : s).slice(0, n || 120);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad request" }); }
  const me = await L.checkPin(b.user, b.pin);
  if (!me) return OK({ error: "pin" });
  const owner = me === "main";
  try {
    const D = await L.load();
    const savePos = () => L.kvSet("purchase_pos", D.pos);
    const today = L.todayIST();

    if (b.action === "get") {
      if (L.autoReceive(D)) await savePos();
      const P = L.plan(D);
      L.syncSuggestions(D, P); await savePos();
      const mine = (r) => owner || r.owner === me;
      return OK({ ok: true, me, name: L.NAMES[me], owner, today, asof: P.asof, stale: P.stale, hasStock: P.hasStock,
        rows: P.rows.filter(mine), pos: D.pos.list.filter(mine), boms: D.boms, cats: L.CATS,
        prod: D.prod.map((o) => ({ customer: o.customer, product: o.product, target: o.targetCases, made: (o.logs || []).reduce((t, l) => t + (+l.qty || 0), 0), promised: o.promisedDate })),
        settings: owner ? D.s : null });
    }
    if (b.action === "count") {          // physical stock count
      const name = clip(b.item, 120); if (!name) return OK({ error: "item?" });
      D.counts[name] = { qty: num(b.qty), d: today, by: me };
      await L.kvSet("purchase_counts", D.counts); return OK({ ok: true });
    }
    if (b.action === "itemSave") {       // owner, category, minimum, reorder qty, lead days, supplier
      const name = clip(b.item, 120); if (!name) return OK({ error: "item?" });
      const cur = D.items[name] || {}, p = b.patch || {};
      if (!owner && cur.owner && cur.owner !== me) return OK({ error: "not your item" });
      ["min", "reorderQty", "leadDays"].forEach((k) => { if (p[k] != null) cur[k] = num(p[k]); });
      ["supplier", "unit", "note", "supplierPhone"].forEach((k) => { if (p[k] != null) cur[k] = clip(p[k], 120); });
      if (p.cat != null && L.CATS[p.cat]) cur.cat = p.cat;
      if (p.track != null) cur.track = !!p.track;
      if (p.owner != null && owner) cur.owner = L.USERS.indexOf(p.owner) >= 0 || p.owner === "" ? p.owner : cur.owner;
      D.items[name] = cur; await L.kvSet("purchase_items", D.items); return OK({ ok: true });
    }
    if (b.action === "order") {          // mark a suggestion (or a fresh line) as ordered
      let p = D.pos.list.find((x) => x.id === b.id);
      if (!p) { p = { id: "po_" + Date.now().toString(36), item: clip(b.item), owner: me === "main" ? (b.owner || "") : me, created: today, unit: clip(b.unit, 20) }; D.pos.list.push(p); }
      if (!owner && p.owner !== me) return OK({ error: "not your order" });
      D.s.poSeq = (D.s.poSeq || 0) + 1; await L.kvSet("purchase_settings", D.s);
      const fy = (today.slice(5) >= "04-01" ? +today.slice(0, 4) : +today.slice(0, 4) - 1);
      Object.assign(p, { status: "ordered", orderedOn: today, orderedBy: me, orderedQty: num(b.qty) || p.qty, supplier: clip(b.supplier || p.supplier),
        expected: b.expected || L.addDays(today, num(b.lead) || (D.items[p.item] || {}).leadDays || D.s.defaultLead), rate: num(b.rate) || null,
        note: clip(b.note, 200), poNo: "ONAM/PO/" + fy + "-" + String(fy + 1).slice(2) + "/" + String(D.s.poSeq).padStart(4, "0"), receivedQty: 0 });
      if (b.supplier) { const it = D.items[p.item] || {}; it.supplier = clip(b.supplier); D.items[p.item] = it; await L.kvSet("purchase_items", D.items); }
      await savePos(); return OK({ ok: true, po: p });
    }
    if (b.action === "receive") {
      const p = D.pos.list.find((x) => x.id === b.id); if (!p) return OK({ error: "not found" });
      if (!owner && p.owner !== me) return OK({ error: "not your order" });
      p.receivedQty = (p.receivedQty || 0) + num(b.qty); p.receivedOn = b.date || today; p.receivedBy = me;
      if (b.full || p.receivedQty >= 0.9 * (p.orderedQty || 0)) p.status = "received";
      await savePos(); return OK({ ok: true });
    }
    if (b.action === "expected") {        // supplier gave a new date
      const p = D.pos.list.find((x) => x.id === b.id); if (!p) return OK({ error: "not found" });
      if (!owner && p.owner !== me) return OK({ error: "not your order" });
      p.expected = b.date; p.note = clip((p.note ? p.note + " · " : "") + (b.note || ""), 300); await savePos(); return OK({ ok: true });
    }
    if (b.action === "cancel") {
      const p = D.pos.list.find((x) => x.id === b.id); if (!p) return OK({ error: "not found" });
      if (!owner && p.owner !== me) return OK({ error: "not your order" });
      p.status = "cancelled"; p.cancelledOn = today; p.cancelledBy = me; await savePos(); return OK({ ok: true });
    }
    if (b.action === "snooze") {          // "not needed now" — hide the suggestion for N days
      const name = clip(b.item); D.snooze[name] = L.addDays(today, Math.min(60, Math.max(1, num(b.days) || 7)));
      await L.kvSet("purchase_snooze", D.snooze); return OK({ ok: true });
    }
    if (b.action === "addItem") {         // a material Tally doesn't list
      const name = clip(b.item, 120); if (!name) return OK({ error: "item?" });
      const cat = L.CATS[b.cat] ? b.cat : L.classify(name);
      D.items[name] = Object.assign(D.items[name] || {}, { cat, owner: owner ? (b.owner != null ? b.owner : (L.OWNER_OF[cat] || "")) : me, unit: clip(b.unit, 20), track: true });
      await L.kvSet("purchase_items", D.items);
      if (b.qty != null && b.qty !== "") { D.counts[name] = { qty: num(b.qty), d: today, by: me }; await L.kvSet("purchase_counts", D.counts); }
      return OK({ ok: true });
    }
    if (!owner) return OK({ error: "owner only" });
    if (b.action === "bomSave") {
      const prod = clip(b.product, 120); if (!prod) return OK({ error: "product?" });
      D.boms[prod] = (b.lines || []).filter((l) => l && l.item && num(l.perCase) > 0).map((l) => ({ item: clip(l.item), perCase: num(l.perCase) }));
      await L.kvSet("purchase_boms", D.boms); return OK({ ok: true });
    }
    if (b.action === "bomDel") { delete D.boms[b.product]; await L.kvSet("purchase_boms", D.boms); return OK({ ok: true }); }
    if (b.action === "settingsSave") {
      const p = b.settings || {}, s = D.s;
      ["ownerEmail", "prakashEmail", "viruEmail", "maadhuEmail"].forEach((k) => { if (p[k] != null) s[k] = clip(p[k], 120); });
      ["coverDays", "defaultLead"].forEach((k) => { if (p[k] != null) s[k] = Math.max(1, num(p[k])); });
      ["emailStaff", "emailOwner"].forEach((k) => { if (p[k] != null) s[k] = !!p[k]; });
      await L.kvSet("purchase_settings", s); return OK({ ok: true });
    }
    if (b.action === "runNow") {
      const r = await require("./purchase-daily.js").run({ force: true, only: b.only });
      return OK({ ok: true, sent: r });
    }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e && e.message || e) }); }
};
