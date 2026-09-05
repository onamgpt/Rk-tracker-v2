/* AIM Quality Screener v3 — client runner shared by /trading and /usa.
 * Depends on window.AIMScreen (aim-screener.js) and on the host page providing:
 *   AIM_HOST = { market:"IN"|"US", getUniverse(kind)→Promise<string[]>,
 *                fetchBars(sym, range)→Promise<[{close,volume}]>, fmtMoney(n) }
 */
(function () {
  "use strict";
  var E = window.AIMScreen;
  var CANCEL = false;
  var LAST = { ranked: [], excluded: {}, market: null, at: null };

  function el(id) { return document.getElementById(id); }
  function status(msg) { var s = el("aim3-status"); if (s) s.innerHTML = msg; }
  function pct(x) { return (x * 100).toFixed(0) + "%"; }

  async function dbGet(key) {
    try { var r = await fetch("/.netlify/functions/db", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "getPortfolio", key: key, user: "main" }) }); var j = await r.json(); return j && j.ok ? j.data : null; } catch (e) { return null; }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Run a list of async tasks with limited concurrency, calling onEach after each.
  async function pool(items, n, worker, onEach) {
    var i = 0, done = 0;
    async function lane() { while (i < items.length && !CANCEL) { var k = i++; var it = items[k]; try { await worker(it); } catch (e) {} done++; if (onEach) onEach(done); } }
    var lanes = []; for (var l = 0; l < n; l++) lanes.push(lane());
    await Promise.all(lanes);
  }

  async function run(kind) {
    CANCEL = false;
    var H = window.AIM_HOST, mk = E.MARKETS[H.market];
    var out = el("aim3-results"); out.innerHTML = "";
    status("Preparing stock list…");
    var universe = await H.getUniverse(kind);
    if (!universe || !universe.length) { status("❌ Could not load the stock list" + (H.market === "IN" ? " — connect Zerodha in Settings, or use Quick Scan." : ".")); return; }

    /* ---------- Stage 1: behaviour across the universe (2y) ---------- */
    var stage1 = [], excluded = {};
    var t0 = Date.now();
    await pool(universe, 12, async function (sym) {
      var bars = await H.fetchBars(sym, "2y");
      var a = bars ? E.analyzeSeries(bars) : null;
      if (!a) { excluded["insufficient price history"] = (excluded["insufficient price history"] || 0) + 1; return; }
      var g = E.gates(a, null, mk, null, true);   // light: behaviour sanity only on 2y data
      if (g.length) { g.forEach(function (r) { excluded[r] = (excluded[r] || 0) + 1; }); return; }
      stage1.push({ sym: sym, a: a, prelim: E.prelimScore(a) });
    }, function (done) {
      if (done % 24 === 0 || done === universe.length) {
        var rate = done / ((Date.now() - t0) / 1000);
        status("📡 Stage 1 · behaviour scan " + done + "/" + universe.length + " · " + stage1.length + " pass · ETA " + Math.ceil((universe.length - done) / Math.max(rate, 1) / 60) + " min");
      }
    });
    if (CANCEL) { status("⏹ Stopped."); return; }
    stage1.sort(function (x, y) { return y.prelim - x.prelim; });
    var shortlist = stage1.slice(0, 150);
    if (!shortlist.length) { status("No stock passed the behaviour screen. " + summarise(excluded)); return; }

    /* ---------- Stage 1b: deeper history (5y) for the shortlist ---------- */
    status("🔎 Stage 2 · deep history on " + shortlist.length + " candidates…");
    await pool(shortlist, 8, async function (c) {
      var bars = await H.fetchBars(c.sym, "5y");
      var a = bars ? E.analyzeSeries(bars) : null;
      if (a) c.a = a;
    });
    if (CANCEL) { status("⏹ Stopped."); return; }

    /* ---------- Stage 2: fundamentals & protection ---------- */
    var funds = {}, surv = { ok: false, flags: {} };
    if (H.market === "US") {
      status("🛡 Stage 3 · SEC EDGAR fundamentals…");
      var table = await dbGet("us_fundamentals");
      var stale = !table || !table.builtAt || (Date.now() - new Date(table.builtAt).getTime()) > 7 * 86400000;
      if (stale) {
        fetch("/.netlify/functions/edgar-build-background", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(function () {});
        for (var w = 0; w < 60 && !CANCEL; w++) {  // up to ~5 min
          await sleep(5000);
          var jb = await dbGet("us_fund_job");
          status("🛡 Stage 3 · building SEC fundamentals table (one-time, then cached 7 days)… " + (jb && jb.step ? jb.step : "") + " " + (w * 5) + "s");
          if (jb && (jb.state === "done" || jb.state === "error")) break;
        }
        table = await dbGet("us_fundamentals");
      }
      if (table && table.data) funds = table.data;
    } else {
      status("🛡 Stage 3 · India fundamentals + NSE surveillance (background job)…");
      var syms = shortlist.map(function (c) { return c.sym; });
      fetch("/.netlify/functions/india-fund-background", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: syms }) }).catch(function () {});
      for (var w2 = 0; w2 < 120 && !CANCEL; w2++) {  // up to ~10 min
        await sleep(5000);
        var jb2 = await dbGet("in_fund_job");
        if (jb2) status("🛡 Stage 3 · fundamentals " + (jb2.done || 0) + "/" + (jb2.total || syms.length) + " · NSE surveillance: " + (jb2.surveillance || "…") + " · " + (w2 * 5) + "s");
        if (jb2 && (jb2.state === "done" || jb2.state === "error")) break;
      }
      var fdata = await dbGet("in_fundamentals");
      if (fdata && fdata.data) funds = fdata.data;
      var sv = await dbGet("in_surveillance");
      if (sv) surv = sv;
    }
    if (CANCEL) { status("⏹ Stopped."); return; }

    /* ---------- Stage 3: final gates, scoring, ranking ---------- */
    var ranked = [];
    shortlist.forEach(function (c) {
      var f = funds[c.sym]; if (f && f.error) f = null;
      var m = f ? E.protectionMetrics(f, c.a.ltp) : null;
      var sflags = (surv && surv.ok && surv.flags && surv.flags[c.sym]) ? { flags: surv.flags[c.sym] } : null;
      var g = E.gates(c.a, m, mk, sflags);
      if (g.length) { g.forEach(function (r) { excluded[r] = (excluded[r] || 0) + 1; }); return; }
      var s = E.score(c.a, m, mk);
      ranked.push({ sym: c.sym, a: c.a, m: m, s: s, reasons: E.reasons(c.a, m, mk), verified: s.verified, survChecked: !!(surv && surv.ok) });
    });
    ranked.sort(function (x, y) { return y.s.total - x.s.total; });
    LAST = { ranked: ranked, excluded: excluded, market: H.market, at: new Date(), universe: universe.length, shortlist: shortlist.length, survOk: !!(surv && surv.ok) };
    render(LAST, mk);
    status("✅ Done · " + universe.length + " scanned → " + shortlist.length + " deep-checked → " + ranked.length + " passed every gate. Showing the top " + Math.min(20, ranked.length) + ".");
  }

  function summarise(ex) {
    var ks = Object.keys(ex).sort(function (a, b) { return ex[b] - ex[a]; });
    return ks.map(function (k) { return ex[k] + " × " + k; }).join(" · ");
  }

  function render(L, mk) {
    var H = window.AIM_HOST;
    var top = L.ranked.slice(0, 20);
    var html = '<div class="card"><h3>🎯 AIM Quality Picks — top ' + top.length + ' of ' + L.ranked.length + ' that passed every gate</h3>';
    html += '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap"><button class="small" onclick="AIM3.csv()">⬇ CSV (all ' + L.ranked.length + ')</button><button class="small sec" onclick="AIM3.audit()">🧾 What was cut &amp; why</button></div>';
    if (!L.survOk && mk.code === "IN") html += '<div class="status" style="background:#fff4e5;color:#7a4a00">⚠️ NSE surveillance file could not be fetched — ASM/GSM/ESM status NOT checked this run. Verify on nseindia.com before buying.</div>';
    top.forEach(function (r, i) {
      var chips = r.reasons.map(function (t) { return '<span style="display:inline-block;background:#f0f0f6;border-radius:12px;padding:2px 8px;margin:2px 3px 0 0;font-size:11px">' + t + '</span>'; }).join("");
      html += '<div class="card" style="margin:8px 0">'
        + '<div class="row"><strong>#' + (i + 1) + ' ' + r.sym + '</strong><span class="val gold">' + r.s.total + '/100</span></div>'
        + '<div class="row"><span class="lbl">LTP</span><span class="val">' + H.fmtMoney(r.a.ltp) + '</span></div>'
        + '<div class="row"><span class="lbl">Bounce ' + Math.round(r.s.bounce) + ' · Vol ' + Math.round(r.s.vol) + ' · Entry ' + Math.round(r.s.pos) + ' · Trend ' + Math.round(r.s.trend) + ' · Quality ' + Math.round(r.s.quality) + '</span></div>'
        + '<div>' + chips + '</div>'
        + (r.verified ? '' : '<div class="muted">⚠️ fundamentals unverified for this stock — quality scored neutral, check before buying</div>')
        + '<button class="small sec" style="margin-top:6px" onclick="AIM3.addToPortfolio(&quot;' + r.sym + '&quot;,' + r.a.ltp + ')">➕ Add to Portfolio</button>'
        + '</div>';
    });
    html += '<div class="muted">Score = proven bounce-back (30) + volatility fit (20) + entry position (15) + 3-yr trend (15) + quality/durability (20). Every stock shown passed: liquidity, price floor, not asleep, at least half its ≥20% falls recovered, not a falling knife, plus fundamentals gates where data existed (profitable, positive cash flow, D/E ≤ 1.5, Altman Z ≥ 1.8, no NSE surveillance flags). Backtest before investing — this is a shortlist, not advice.</div></div>';
    el("aim3-results").innerHTML = html;
  }

  function audit() {
    var L = LAST; if (!L.ranked) return;
    var ks = Object.keys(L.excluded).sort(function (a, b) { return L.excluded[b] - L.excluded[a]; });
    var html = '<div class="card"><h3>🧾 Exclusion audit</h3><table><tr><th>Reason</th><th>Stocks cut</th></tr>';
    ks.forEach(function (k) { html += '<tr><td>' + k + '</td><td>' + L.excluded[k] + '</td></tr>'; });
    html += '</table><div class="muted">Stocks can be cut for more than one reason. Scanned ' + L.universe + ' · deep-checked ' + L.shortlist + ' · passed ' + L.ranked.length + '.</div></div>';
    el("aim3-results").insertAdjacentHTML("afterbegin", html);
  }

  function csv() {
    var L = LAST; if (!L.ranked || !L.ranked.length) { alert("Run a scan first"); return; }
    var lines = ["Rank,Symbol,LTP,Score,Bounce,Vol,Entry,Trend,Quality,Drawdowns,Recovered,AnnVol%,Pos52w%,CAGR3y%,Z,F,DE,RevGrowth%,Promoter%,Verified"];
    L.ranked.forEach(function (r, i) {
      var m = r.m || {};
      lines.push([i + 1, r.sym, r.a.ltp.toFixed(2), r.s.total, Math.round(r.s.bounce), Math.round(r.s.vol), Math.round(r.s.pos), Math.round(r.s.trend), Math.round(r.s.quality),
        r.a.bounce.episodes, r.a.bounce.recovered, (r.a.annVol * 100).toFixed(0), (r.a.pos * 100).toFixed(0), (r.a.cagr * 100).toFixed(1),
        m.z != null ? m.z.toFixed(2) : "", m.fPct != null ? m.f + "/" + m.fMax : "", m.de != null ? m.de.toFixed(2) : "", m.revGrowth != null ? (m.revGrowth * 100).toFixed(1) : "", m.promoterPct != null ? m.promoterPct.toFixed(0) : "", r.verified ? "Y" : "N"].join(","));
    });
    var blob = new Blob([lines.join("\n")], { type: "text/csv" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "AIM-Quality-" + L.market + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function addToPortfolio(sym, ltp) {
    if (window.AIM_HOST && typeof window.AIM_HOST.addHolding === "function") window.AIM_HOST.addHolding(sym, ltp);
    else alert("Add " + sym + " at " + ltp + " in the Portfolio tab.");
  }

  window.AIM3 = { run: run, stop: function () { CANCEL = true; }, csv: csv, audit: audit, addToPortfolio: addToPortfolio, last: function () { return LAST; } };
})();
