/* AIM Quality Screener v3 — shared engine for RK Trading India and USA.
 *
 * Built from Lichello's own selection rules (durability, volatility, volume,
 * upward bias with wild swings, buy strong companies "on their knees"), plus
 * modern capital-protection screens (Altman Z, Piotroski F, cash-flow quality,
 * debt) and India-specific ones (promoter holding, NSE surveillance flags).
 *
 * Pure functions only in this file — no DOM, no fetch — so it can be unit-tested
 * and shared by both apps. The apps do the fetching and rendering.
 */
(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Market configuration                                                 */
  /* ------------------------------------------------------------------ */
  var MARKETS = {
    IN: {
      code: "IN", suffix: ".NS", cur: "₹",
      priceFloor: 20,               // below this = operator/penny territory
      minDailyValue: 5e7,           // ₹5 crore traded per day
      capFloor: 2000e7,             // ₹2,000 crore market cap (mid-cap floor)
      capTaper: 300000e7,           // > ₹3 lakh crore: giants slow down (Lichello)
      promoterMin: 35               // % promoter holding — scored, not gated
    },
    US: {
      code: "US", suffix: "", cur: "$",
      priceFloor: 5,
      minDailyValue: 5e6,           // $5M traded per day
      capFloor: 1e9,                // $1B
      capTaper: 1e11                // > $100B
    }
  };

  /* ------------------------------------------------------------------ */
  /* Behaviour analysis from price bars                                   */
  /* ------------------------------------------------------------------ */

  // bars: [{close, volume}] oldest → newest, daily
  function analyzeSeries(bars) {
    var closes = [], vols = [];
    for (var i = 0; i < bars.length; i++) {
      var c = bars[i].close;
      if (c == null || !(c > 0)) continue;
      closes.push(c);
      vols.push(bars[i].volume || 0);
    }
    if (closes.length < 120) return null;

    var n = closes.length;
    var ltp = closes[n - 1];

    // Annualised volatility from the last 252 daily log returns
    var win = closes.slice(-253);
    var rets = [];
    for (var j = 1; j < win.length; j++) rets.push(Math.log(win[j] / win[j - 1]));
    var mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
    var varc = rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / Math.max(1, rets.length - 1);
    var annVol = Math.sqrt(varc) * Math.sqrt(252);

    // 52-week position
    var yr = closes.slice(-252);
    var hi = Math.max.apply(null, yr), lo = Math.min.apply(null, yr);
    var pos = hi > lo ? (ltp - lo) / (hi - lo) : 0.5;

    // Liquidity: median traded value over the last 60 days
    var lastV = [];
    for (var k = Math.max(0, n - 60); k < n; k++) lastV.push(closes[k] * vols[k]);
    lastV.sort(function (a, b) { return a - b; });
    var medValue = lastV.length ? lastV[Math.floor(lastV.length / 2)] : 0;

    // Trend: CAGR over the window (up to 3y = 756 bars) and 1y return
    var w = closes.slice(-756);
    var years = w.length / 252;
    var cagr = Math.pow(ltp / w[0], 1 / years) - 1;
    var ret1y = ltp / yr[0] - 1;

    // Asleep? Range of the last 6 months
    var h6 = closes.slice(-126);
    var swing6m = Math.max.apply(null, h6) / Math.min.apply(null, h6) - 1;

    var bounce = bounceStats(w);

    return {
      ltp: ltp, bars: n, annVol: annVol, pos: pos, medDailyValue: medValue,
      cagr: cagr, ret1y: ret1y, swing6m: swing6m, bounce: bounce
    };
  }

  /* Bounce-back detector — the "snowball" test.
   * Walk the series tracking the running peak. A drawdown episode opens when
   * price falls 20% or more from that peak. It closes as RECOVERED when price
   * climbs back at least 60% of the way from the trough to the old peak within
   * 250 trading days; otherwise it's FAILED (or, if still open at the end, OPEN).
   * A stock AIM can profit from has several episodes and recovers from them. */
  function bounceStats(closes, dropPct, recoverFrac, maxBars) {
    dropPct = dropPct || 0.20; recoverFrac = recoverFrac || 0.60; maxBars = maxBars || 250;
    var peak = closes[0], peakIdx = 0;
    var inEp = false, trough = 0, troughIdx = 0, epPeak = 0;
    var episodes = [];
    var maxDD = 0;

    for (var i = 0; i < closes.length; i++) {
      var p = closes[i];
      if (!inEp) {
        if (p > peak) { peak = p; peakIdx = i; }
        var dd = 1 - p / peak;
        if (dd > maxDD) maxDD = dd;
        if (dd >= dropPct) { inEp = true; trough = p; troughIdx = i; epPeak = peak; }
      } else {
        if (p < trough) { trough = p; troughIdx = i; }
        var ddNow = 1 - p / epPeak;
        if (ddNow > maxDD) maxDD = ddNow;
        var target = trough + recoverFrac * (epPeak - trough);
        if (p >= target) {
          episodes.push({ drop: 1 - trough / epPeak, recovered: true, bars: i - troughIdx, bounce: p / trough - 1 });
          inEp = false; peak = p; peakIdx = i;
        } else if (i - troughIdx > maxBars) {
          episodes.push({ drop: 1 - trough / epPeak, recovered: false, bars: i - troughIdx, bounce: p / trough - 1 });
          // start fresh from here so a second leg down can be counted separately
          inEp = false; peak = p; peakIdx = i;
        }
      }
    }
    var openDD = null;
    if (inEp) openDD = { drop: 1 - trough / epPeak, sinceTrough: closes.length - 1 - troughIdx, bounceSoFar: closes[closes.length - 1] / trough - 1 };

    var rec = episodes.filter(function (e) { return e.recovered; });
    var avgBars = rec.length ? rec.reduce(function (a, e) { return a + e.bars; }, 0) / rec.length : null;
    var avgBounce = rec.length ? rec.reduce(function (a, e) { return a + e.bounce; }, 0) / rec.length : null;
    return {
      episodes: episodes.length, recovered: rec.length,
      ratio: episodes.length ? rec.length / episodes.length : 0,
      avgRecoverBars: avgBars, avgBounce: avgBounce, maxDrawdown: maxDD, open: openDD
    };
  }

  /* ------------------------------------------------------------------ */
  /* Fundamentals → protection metrics                                    */
  /* ------------------------------------------------------------------ */

  // f: normalised fundamentals {rev, revPrior, ni, niPrior, ebit, ocf, interest,
  //    assets, assetsPrior, liab, equity, curAssets, curLiab, ltd, ltdPrior,
  //    retained, shares, promoterPct, cashPerShare}  (any may be null)
  function protectionMetrics(f, price) {
    if (!f) return null;
    var m = {};
    var mcap = (f.shares && price) ? f.shares * price : (f.marketCap || null);
    m.marketCap = mcap;
    m.de = (f.equity && f.equity > 0 && f.ltd != null) ? f.ltd / f.equity : ((f.equity && f.equity > 0 && f.liab != null) ? f.liab / f.equity : null);
    m.liabToAssets = (f.assets && f.liab != null) ? f.liab / f.assets : null;
    m.roe = (f.equity && f.equity > 0 && f.ni != null) ? f.ni / f.equity : null;
    m.intCover = (f.interest && f.interest > 0 && f.ebit != null) ? f.ebit / f.interest : (f.interest === 0 ? Infinity : null);
    m.revGrowth = (f.rev && f.revPrior && f.revPrior > 0) ? f.rev / f.revPrior - 1 : null;
    m.ocfPositive = f.ocf != null ? f.ocf > 0 : null;
    m.ocfBeatsNI = (f.ocf != null && f.ni != null) ? f.ocf >= f.ni : null;
    m.profitable = (f.ni != null ? f.ni > 0 : null);
    m.profitableEither = ((f.ni != null && f.ni > 0) || (f.niPrior != null && f.niPrior > 0));

    // Financial-sector heuristic: banks/insurers carry 85%+ liabilities by design.
    m.isFinancial = !!(m.liabToAssets != null && m.liabToAssets > 0.80 && (f.rev == null || (f.assets && f.rev / f.assets < 0.15)));

    // Altman Z (original, for non-financials)
    if (!m.isFinancial && f.assets > 0 && f.liab > 0) {
      var wc = (f.curAssets != null && f.curLiab != null) ? (f.curAssets - f.curLiab) : 0;
      var re = f.retained != null ? f.retained : 0;
      var eb = f.ebit != null ? f.ebit : 0;
      var sales = f.rev != null ? f.rev : 0;
      var mv = mcap != null ? mcap : (f.equity || 0);
      m.z = 1.2 * (wc / f.assets) + 1.4 * (re / f.assets) + 3.3 * (eb / f.assets) + 0.6 * (mv / f.liab) + 1.0 * (sales / f.assets);
    } else m.z = null;

    // Piotroski F (subset we can compute from two years of data)
    var F = 0, Fmax = 0;
    function pt(cond, applicable) { if (applicable) { Fmax++; if (cond) F++; } }
    pt(f.ni > 0, f.ni != null);
    pt(f.ocf > 0, f.ocf != null);
    var roa = (f.assets && f.ni != null) ? f.ni / f.assets : null;
    var roaP = (f.assetsPrior && f.niPrior != null) ? f.niPrior / f.assetsPrior : null;
    pt(roa != null && roaP != null && roa > roaP, roa != null && roaP != null);
    pt(f.ocf != null && f.ni != null && f.ocf > f.ni, f.ocf != null && f.ni != null);
    var lev = (f.assets && f.ltd != null) ? f.ltd / f.assets : null;
    var levP = (f.assetsPrior && f.ltdPrior != null) ? f.ltdPrior / f.assetsPrior : null;
    pt(lev != null && levP != null && lev <= levP, lev != null && levP != null);
    pt(m.revGrowth != null && m.revGrowth > 0, m.revGrowth != null);
    pt(f.sharesPrior != null && f.shares != null && f.shares <= f.sharesPrior * 1.02, f.sharesPrior != null && f.shares != null);
    m.f = F; m.fMax = Fmax;
    m.fPct = Fmax ? F / Fmax : null;

    m.promoterPct = f.promoterPct != null ? f.promoterPct : null;
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* Gates (hard exclusions) and scoring                                  */
  /* ------------------------------------------------------------------ */

  // light=true: stage-1 pass on 2 years of data — behaviour sanity only.
  // The bounce-history gates need the full 5-year window, so they only run
  // at the final stage (light=false); otherwise a stock whose last big
  // correction-and-recovery was 2½ years ago would be cut before we looked.
  function gates(a, m, mk, surv, light) {
    var out = [];
    if (!a) { out.push("insufficient price history"); return out; }
    if (a.ltp < mk.priceFloor) out.push("price below " + mk.cur + mk.priceFloor);
    if (a.medDailyValue < mk.minDailyValue) out.push("illiquid (daily value too low)");
    if (a.swing6m < 0.15) out.push("asleep — under 15% range in 6 months");
    if (!light) {
      if (a.bounce.episodes === 0) out.push("no ≥20% drawdown in 3 years — nothing for AIM to harvest");
      else if (a.bounce.ratio < 0.5) out.push("falls but doesn't recover (" + a.bounce.recovered + "/" + a.bounce.episodes + " bounced)");
    }
    if (a.bounce.maxDrawdown > 0.70 && a.bounce.open && a.bounce.open.drop > 0.60) out.push("still down more than 60% from peak — falling knife");
    if (a.cagr < -0.25) out.push("3-year trend below −25%/yr — structural decline");
    if (a.annVol > 1.3) out.push("volatility above 130% — manipulation/junk territory");

    if (surv && surv.flags && surv.flags.length) out.push("NSE surveillance: " + surv.flags.join(", "));

    if (m) {
      if (m.marketCap != null && m.marketCap < mk.capFloor) out.push("market cap below floor");
      if (!m.profitableEither) out.push("loss-making both of the last two years");
      if (m.ocfPositive === false) out.push("negative operating cash flow");
      if (!m.isFinancial) {
        if (m.de != null && m.de > 1.5) out.push("debt/equity above 1.5");
        if (m.z != null && m.z < 1.8) out.push("Altman Z in distress zone (" + m.z.toFixed(2) + ")");
        if (m.intCover != null && m.intCover !== Infinity && m.intCover < 2) out.push("interest cover under 2×");
      } else {
        out.push("financial sector — leverage rules differ; excluded by design");
      }
      if (mk.code === "IN" && m.promoterPct != null && m.promoterPct < 20) out.push("promoter holding under 20%");
    }
    return out;
  }

  function score(a, m, mk) {
    var s = {};
    var b = a.bounce;
    // Bounce (30): proven, repeated recovery
    s.bounce = b.episodes ? 30 * (0.6 * b.ratio + 0.4 * Math.min(1, b.episodes / 3)) : 0;
    // Volatility (20): sweet band 30–70% annualised
    var v = a.annVol;
    s.vol = v < 0.15 ? 0 : v < 0.30 ? 14 * (v - 0.15) / 0.15 : v <= 0.70 ? 20 : v <= 1.0 ? 20 - 12 * (v - 0.70) / 0.30 : 4;
    // Entry position (15): strong company on its knees, not at the highs
    var p = a.pos;
    s.pos = p < 0.05 ? 3 : p < 0.10 ? 8 : p <= 0.45 ? 15 : p <= 0.65 ? 9 : p <= 0.85 ? 4 : 1;
    // Trend (15): staggers up the mountain
    var c = a.cagr;
    s.trend = c < -0.10 ? 0 : c < 0 ? 4 : c < 0.10 ? 9 : c <= 0.30 ? 15 : 13;
    // Quality (20)
    if (m && !m.isFinancial) {
      var q = 0;
      q += m.z == null ? 2 : m.z >= 3 ? 6 : m.z >= 1.8 ? 3 : 0;
      q += m.fPct == null ? 2 : m.fPct >= 0.75 ? 6 : m.fPct >= 0.5 ? 4 : m.fPct >= 0.3 ? 2 : 0;
      q += m.de == null ? 1 : m.de <= 0.3 ? 4 : m.de <= 0.8 ? 3 : m.de <= 1.5 ? 1 : 0;
      q += (m.ocfPositive && m.ocfBeatsNI) ? 2 : 0;
      q += (m.revGrowth != null && m.revGrowth > 0) ? 2 : 0;
      if (mk.code === "IN" && m.promoterPct != null) { if (m.promoterPct < 35) q -= 2; else if (m.promoterPct < 50) q -= 1; }
      s.quality = Math.max(0, Math.min(20, q));
      s.verified = true;
    } else {
      s.quality = 6; s.verified = false;
    }
    var total = s.bounce + s.vol + s.pos + s.trend + s.quality;
    if (m && m.marketCap != null && m.marketCap > mk.capTaper) total *= 0.9;
    s.total = Math.round(total);
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* Preliminary (stage-1 only) ranking used to pick the shortlist         */
  /* ------------------------------------------------------------------ */
  function prelimScore(a) {
    var b = a.bounce;
    var bs = b.episodes ? 30 * (0.6 * b.ratio + 0.4 * Math.min(1, b.episodes / 3)) : 0;
    var v = a.annVol;
    var vs = v < 0.15 ? 0 : v < 0.30 ? 14 * (v - 0.15) / 0.15 : v <= 0.70 ? 20 : v <= 1.0 ? 20 - 12 * (v - 0.70) / 0.30 : 4;
    var p = a.pos;
    var ps = p < 0.05 ? 3 : p < 0.10 ? 8 : p <= 0.45 ? 15 : p <= 0.65 ? 9 : p <= 0.85 ? 4 : 1;
    var c = a.cagr;
    var ts = c < -0.10 ? 0 : c < 0 ? 4 : c < 0.10 ? 9 : c <= 0.30 ? 15 : 13;
    return bs + vs + ps + ts;
  }

  function reasons(a, m, mk) {
    var r = [];
    var b = a.bounce;
    if (b.episodes) r.push(b.recovered + "/" + b.episodes + " drawdowns bounced" + (b.avgRecoverBars ? " (~" + Math.round(b.avgRecoverBars / 21) + " mo)" : ""));
    r.push("vol " + Math.round(a.annVol * 100) + "%");
    r.push(Math.round(a.pos * 100) + "% of 52w range");
    r.push("3y " + (a.cagr >= 0 ? "+" : "") + Math.round(a.cagr * 100) + "%/yr");
    if (m) {
      if (m.z != null) r.push("Z " + m.z.toFixed(1));
      if (m.fPct != null) r.push("F " + m.f + "/" + m.fMax);
      if (m.de != null) r.push("D/E " + m.de.toFixed(2));
      if (m.revGrowth != null) r.push("rev " + (m.revGrowth >= 0 ? "+" : "") + Math.round(m.revGrowth * 100) + "%");
      if (mk.code === "IN" && m.promoterPct != null) r.push("promoter " + Math.round(m.promoterPct) + "%");
    } else r.push("fundamentals unverified");
    return r;
  }

  root.AIMScreen = {
    MARKETS: MARKETS,
    analyzeSeries: analyzeSeries,
    bounceStats: bounceStats,
    protectionMetrics: protectionMetrics,
    gates: gates,
    score: score,
    prelimScore: prelimScore,
    reasons: reasons
  };
})(typeof window !== "undefined" ? window : (typeof module !== "undefined" ? module.exports : this));
