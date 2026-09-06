/* Selection Engine v1 — standalone, for /screener.
 *
 * INDEPENDENT COPY. Shares no code with trading/aim-screener.js by design:
 * nothing here can alter the behaviour of the live trading apps.
 *
 * Two deliberately separate axes, per the brief:
 *
 *   COMPANY QUALITY  — is this a sound business? Solvency, profitability,
 *                      cash-flow quality, leverage, governance.
 *   AIM SUITABILITY  — does this price series give AIM something to work on?
 *                      Oscillation, amplitude, mean-reversion character.
 *
 * A high AIM-suitability score can never rescue a company that fails a
 * solvency gate. Gates run first and are absolute; scores only rank whatever
 * survives them.
 *
 * Pure functions only — no DOM, no fetch — so this file can be unit-tested.
 */
(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Market configuration                                               */
  /* ------------------------------------------------------------------ */
  var MARKETS = {
    IN: {
      code: "IN", suffix: ".NS", cur: "\u20b9",
      priceFloor: 20,
      minDailyValue: 5e7,        // Rs 5 crore traded per day
      capFloor: 2000e7,          // Rs 2,000 crore
      capTaper: 300000e7         // Rs 3 lakh crore — giants move less
    },
    US: {
      code: "US", suffix: "", cur: "$",
      priceFloor: 5,
      minDailyValue: 5e6,        // $5M traded per day
      capFloor: 1e9,             // $1B
      capTaper: 1e11             // $100B
    }
  };

  /* ------------------------------------------------------------------ */
  /* Price-series analysis                                              */
  /* ------------------------------------------------------------------ */

  // bars: [{close, volume}] oldest -> newest, daily
  function analyzeSeries(bars) {
    if (!bars || !bars.length) return null;
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

    // Daily log returns over the last trading year
    var win = closes.slice(-253);
    var rets = [];
    for (var j = 1; j < win.length; j++) rets.push(Math.log(win[j] / win[j - 1]));
    var mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
    var varc = rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / Math.max(1, rets.length - 1);
    var annVol = Math.sqrt(varc) * Math.sqrt(252);

    // Position within the 52-week range
    var yr = closes.slice(-252);
    var hi = Math.max.apply(null, yr), lo = Math.min.apply(null, yr);
    var pos = hi > lo ? (ltp - lo) / (hi - lo) : 0.5;

    // Liquidity: median traded value over the last 60 sessions.
    // Median, not mean, so a single block deal cannot make an illiquid
    // stock look tradeable.
    var lastV = [];
    for (var k = Math.max(0, n - 60); k < n; k++) lastV.push(closes[k] * vols[k]);
    lastV.sort(function (a, b) { return a - b; });
    var medValue = lastV.length ? lastV[Math.floor(lastV.length / 2)] : 0;

    // Trend over the available window (up to 3y) and over 1y
    var w = closes.slice(-756);
    var years = w.length / 252;
    var cagr = Math.pow(ltp / w[0], 1 / years) - 1;
    var ret1y = ltp / yr[0] - 1;

    // Is it awake? Range of the last 6 months.
    var h6 = closes.slice(-126);
    var swing6m = Math.max.apply(null, h6) / Math.min.apply(null, h6) - 1;

    return {
      ltp: ltp, bars: n, annVol: annVol, pos: pos, medDailyValue: medValue,
      cagr: cagr, ret1y: ret1y, swing6m: swing6m,
      bounce: bounceStats(w)
    };
  }

  /* Drawdown-and-recovery episodes — how many round trips AIM would have had.
   *
   * Walk the series tracking the running peak. An episode opens when price
   * falls >= dropPct from that peak. It closes as RECOVERED when price climbs
   * back at least recoverFrac of the way from the trough to the old peak
   * within maxBars sessions; otherwise it closes as failed.
   *
   * Parameter rationale (three, all fixed, none fitted to results):
   *   dropPct     0.20 — a fall smaller than this does not move AIM's
   *                      Portfolio Control enough to generate a real order.
   *   recoverFrac 0.60 — AIM sells into strength on the way back up; it does
   *                      not need a full retrace to the old peak to profit.
   *   maxBars      250 — roughly one trading year. Recovery slower than this
   *                      ties up the cash pool for longer than the method
   *                      assumes.
   */
  function bounceStats(closes, dropPct, recoverFrac, maxBars) {
    dropPct = dropPct || 0.20;
    recoverFrac = recoverFrac || 0.60;
    maxBars = maxBars || 250;

    var peak = closes[0];
    var inEp = false, trough = 0, troughIdx = 0, epPeak = 0;
    var episodes = [];
    var maxDD = 0;

    for (var i = 0; i < closes.length; i++) {
      var p = closes[i];
      if (!inEp) {
        if (p > peak) peak = p;
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
          inEp = false; peak = p;
        } else if (i - troughIdx > maxBars) {
          episodes.push({ drop: 1 - trough / epPeak, recovered: false, bars: i - troughIdx, bounce: p / trough - 1 });
          inEp = false; peak = p;
        }
      }
    }

    var openDD = null;
    if (inEp) {
      openDD = {
        drop: 1 - trough / epPeak,
        sinceTrough: closes.length - 1 - troughIdx,
        bounceSoFar: closes[closes.length - 1] / trough - 1
      };
    }

    var rec = episodes.filter(function (e) { return e.recovered; });
    var avgBars = rec.length ? rec.reduce(function (a, e) { return a + e.bars; }, 0) / rec.length : null;
    var avgBounce = rec.length ? rec.reduce(function (a, e) { return a + e.bounce; }, 0) / rec.length : null;

    return {
      episodes: episodes.length,
      recovered: rec.length,
      ratio: episodes.length ? rec.length / episodes.length : 0,
      avgRecoverBars: avgBars,
      avgBounce: avgBounce,
      maxDrawdown: maxDD,
      open: openDD,
      years: closes.length / 252
    };
  }

  /* On mean reversion, and a measure that was tried and removed.
   *
   * An earlier version of this engine scored a Lo-MacKinlay variance ratio
   * as a mean-reversion statistic. It was removed after testing, not on
   * taste: on a pure sine wave — the most mean-reverting series that can
   * exist — VR(10) reported 9.8, i.e. "strongly trending", and the reading
   * moved from 0.43 to 2.06 on a realistic noisy oscillation depending only
   * on the horizon k, which had no principled value.
   *
   * The reason is that VR measures autocorrelation of returns, which is not
   * the same question as "does this price come back". A smooth oscillation
   * has positively autocorrelated short-horizon returns because it keeps
   * moving the same way within each half-cycle.
   *
   * The drawdown-and-recovery statistics below already measure the property
   * AIM actually depends on — completed round trips — directly, in units
   * that mean something. That is the mean-reversion measure used here.
   */

  /* ------------------------------------------------------------------ */
  /* Fundamentals -> protection metrics                                 */
  /* ------------------------------------------------------------------ */

  // f: {rev, revPrior, ni, niPrior, ebit, ocf, interest, assets, assetsPrior,
  //     liab, equity, curAssets, curLiab, ltd, ltdPrior, retained, shares,
  //     sharesPrior, promoterPct, marketCap}   (any may be null)
  function protectionMetrics(f, price) {
    if (!f) return null;
    var m = {};
    var mcap = (f.shares && price) ? f.shares * price : (f.marketCap || null);
    m.marketCap = mcap;

    m.de = (f.equity && f.equity > 0 && f.ltd != null) ? f.ltd / f.equity
         : ((f.equity && f.equity > 0 && f.liab != null) ? f.liab / f.equity : null);
    m.liabToAssets = (f.assets && f.liab != null) ? f.liab / f.assets : null;
    m.roe = (f.equity && f.equity > 0 && f.ni != null) ? f.ni / f.equity : null;

    /* Interest cover.
     *
     * Deliberate change from v3: v3 mapped "no interest expense" to Infinity,
     * which then skipped the cover gate entirely. That is right for a
     * debt-free company but wrong for one whose EBIT is negative — a
     * loss-making business with no debt would sail through a solvency check
     * it should never have reached.
     *
     * Here the two cases are kept apart: intCover is null when there is no
     * interest expense, and ebitPositive carries the "is it actually earning"
     * question separately. Both are gated.
     */
    m.intCover = (f.interest && f.interest > 0 && f.ebit != null) ? f.ebit / f.interest : null;
    m.noInterestExpense = (f.interest === 0 || f.interest == null);
    m.ebitPositive = f.ebit != null ? f.ebit > 0 : null;

    m.revGrowth = (f.rev && f.revPrior && f.revPrior > 0) ? f.rev / f.revPrior - 1 : null;
    m.ocfPositive = f.ocf != null ? f.ocf > 0 : null;
    m.ocfBeatsNI = (f.ocf != null && f.ni != null) ? f.ocf >= f.ni : null;
    m.profitable = f.ni != null ? f.ni > 0 : null;
    m.profitableEither = ((f.ni != null && f.ni > 0) || (f.niPrior != null && f.niPrior > 0));

    /* Accrual quality (Sloan 1996).
     * (Net income - operating cash flow) / total assets. High positive
     * accruals mean reported profit is not arriving as cash, and predict
     * weaker subsequent returns. Identified as a gap in the Phase 1 audit.
     * Scored, and gated only at an extreme level.
     */
    m.accruals = (f.ni != null && f.ocf != null && f.assets > 0) ? (f.ni - f.ocf) / f.assets : null;

    // Banks and insurers carry 85%+ liabilities by design; the leverage and
    // Altman rules below do not apply to them.
    m.isFinancial = !!(m.liabToAssets != null && m.liabToAssets > 0.80 &&
                       (f.rev == null || (f.assets && f.rev / f.assets < 0.15)));

    // Altman Z (original, non-financials only)
    if (!m.isFinancial && f.assets > 0 && f.liab > 0) {
      var wc = (f.curAssets != null && f.curLiab != null) ? (f.curAssets - f.curLiab) : 0;
      var re = f.retained != null ? f.retained : 0;
      var eb = f.ebit != null ? f.ebit : 0;
      var sales = f.rev != null ? f.rev : 0;
      var mv = mcap != null ? mcap : (f.equity || 0);
      m.z = 1.2 * (wc / f.assets) + 1.4 * (re / f.assets) + 3.3 * (eb / f.assets) +
            0.6 * (mv / f.liab) + 1.0 * (sales / f.assets);
    } else m.z = null;

    // Piotroski F — the subset computable from two years of data.
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
    pt(f.sharesPrior != null && f.shares != null && f.shares <= f.sharesPrior * 1.02,
       f.sharesPrior != null && f.shares != null);
    m.f = F; m.fMax = Fmax;
    m.fPct = Fmax ? F / Fmax : null;

    m.promoterPct = f.promoterPct != null ? f.promoterPct : null;
    // Pledge does not appear in company filings the way the other figures do;
    // the caller attaches it from the universe file. Carried here so the
    // penalty applies on this basis too, not only the universe one.
    m.pledge = f.pledge != null ? f.pledge : null;
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* GATES — absolute exclusions, run before any scoring                */
  /* ------------------------------------------------------------------ */

  /* Returns an array of plain-language reasons. Empty array = passed.
   *
   * These are exclusions, not preferences. Nothing in either score can
   * overturn one. In particular a stock with beautiful oscillation still
   * fails here if it is insolvent.
   *
   * light=true runs only the checks that two years of price data support,
   * for the first pass over a large universe.
   */
  function gates(a, m, mk, surv, light) {
    var out = [];
    if (!a) { out.push("insufficient price history"); return out; }

    /* --- liquidity and tradeability --- */
    if (a.ltp < mk.priceFloor) out.push("price below " + mk.cur + mk.priceFloor);
    if (a.medDailyValue < mk.minDailyValue) out.push("illiquid — median daily traded value too low");

    /* --- does the series give AIM anything at all --- */
    if (a.swing6m < 0.15) out.push("asleep — under 15% range in 6 months");
    if (!light) {
      if (a.bounce.episodes === 0) out.push("no fall of 20% or more in 3 years — nothing for AIM to harvest");
      else if (a.bounce.ratio < 0.5) out.push("falls but does not recover (" + a.bounce.recovered + " of " + a.bounce.episodes + " bounced)");
    }

    /* --- AIM's known failure mode, screened for directly --- */
    if (a.bounce.maxDrawdown > 0.70 && a.bounce.open && a.bounce.open.drop > 0.60)
      out.push("still down over 60% from peak — falling knife, AIM would keep buying into it");
    if (a.cagr < -0.25) out.push("3-year trend below -25%/yr — structural decline");

    /* --- junk / manipulation --- */
    if (a.annVol > 1.3) out.push("volatility above 130% — manipulation or junk territory");

    /* --- regulator flags --- */
    if (surv && surv.flags && surv.flags.length) out.push("NSE surveillance: " + surv.flags.join(", "));

    /* --- solvency and accounting --- */
    if (m && m.basis === "universe") {
      // Only the checks this data can actually support. The universe was
      // pre-gated on the rest, and pretending otherwise would report a
      // solvency check that never ran.
      if (m.marketCap != null && m.marketCap < mk.capFloor) out.push("market cap below floor");
      if (m.intCover != null && m.intCover < 2) out.push("interest cover under 2x");
      if (m.de != null && m.de > 1.5) out.push("debt to equity above 1.5");
      if (mk.code === "IN" && m.promoterPct != null && m.promoterPct < 20) out.push("promoter holding under 20%");
      return out;
    }

    if (m) {
      if (m.marketCap != null && m.marketCap < mk.capFloor) out.push("market cap below floor");
      if (!m.profitableEither) out.push("loss-making in both of the last two years");
      if (m.ocfPositive === false) out.push("negative operating cash flow");

      // Closes the v3 gap: a debt-free company with negative EBIT previously
      // skipped the interest-cover check because cover was Infinity.
      if (m.ebitPositive === false) out.push("negative EBIT — operating loss before financing");

      if (!m.isFinancial) {
        if (m.de != null && m.de > 1.5) out.push("debt to equity above 1.5");
        if (m.z != null && m.z < 1.8) out.push("Altman Z in distress zone (" + m.z.toFixed(2) + ")");
        if (m.intCover != null && m.intCover < 2) out.push("interest cover under 2x");
        // Extreme accruals only. Moderate accruals are scored, not gated,
        // because the effect is a tilt in average returns, not a failure.
        if (m.accruals != null && m.accruals > 0.25) out.push("extreme accruals — reported profit is not arriving as cash");
      } else {
        out.push("financial sector — leverage and Altman rules do not apply; excluded by design");
      }
      if (mk.code === "IN" && m.promoterPct != null && m.promoterPct < 20)
        out.push("promoter holding under 20%");
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* AXIS 1 — COMPANY QUALITY (0-100)                                   */
  /* ------------------------------------------------------------------ */

  /* Built only from measures with published out-of-sample support:
   * Altman Z (distress), Piotroski F (fundamental strength), leverage,
   * cash-flow quality, accruals, and — for India — promoter holding.
   *
   * Deliberately excludes anything about the price series. A company does
   * not become better run because its shares oscillate.
   */
  function qualityScore(m, mk) {
    if (!m) return { total: null, verified: false, parts: {}, note: "fundamentals unavailable" };
    if (m.isFinancial) return { total: null, verified: false, parts: {}, note: "financial sector — not scored" };

    var p = {};

    // Solvency (30) — Altman Z. The strongest single distress predictor here.
    p.solvency = m.z == null ? 12 : m.z >= 3 ? 30 : m.z >= 2.6 ? 24 : m.z >= 1.8 ? 15 : 0;

    // Fundamental strength (25) — Piotroski F as a proportion of applicable tests.
    p.strength = m.fPct == null ? 10 : Math.round(25 * m.fPct);

    // Leverage (15)
    p.leverage = m.de == null ? 6 : m.de <= 0.3 ? 15 : m.de <= 0.8 ? 11 : m.de <= 1.5 ? 5 : 0;

    // Cash-flow quality (20) — does profit arrive as cash?
    var cq = 0;
    if (m.ocfPositive) cq += 8;
    if (m.ocfBeatsNI) cq += 6;
    if (m.accruals != null) cq += m.accruals <= 0 ? 6 : m.accruals <= 0.10 ? 4 : m.accruals <= 0.20 ? 2 : 0;
    else cq += 3;
    p.cashQuality = cq;

    // Growth (10) — modest weight. Revenue going backwards is a warning;
    // rapid growth is not evidence of quality.
    p.growth = m.revGrowth == null ? 4 : m.revGrowth > 0.05 ? 10 : m.revGrowth > 0 ? 7 : m.revGrowth > -0.05 ? 3 : 0;

    // Governance (India only) — promoter holding. A judgement call, not an
    // out-of-sample-validated factor: low promoter holding is associated with
    // weaker alignment in Indian mid-caps, but the evidence is thinner than
    // for Z or F. Small weight to reflect that.
    var gov = 0;
    if (mk.code === "IN" && m.promoterPct != null) {
      gov = m.promoterPct >= 50 ? 0 : m.promoterPct >= 35 ? -3 : -7;
    }
    p.governance = gov;

    // Promoter pledge. A forced-selling risk unrelated to the operating
    // business. Applied on this basis as well as the universe one, so that
    // building a richer fundamentals table can never make pledge stop
    // counting.
    var pl = m.pledge;
    p.pledgePenalty = pl == null ? 0
                    : pl >= 20 ? -20
                    : pl >= 10 ? -12
                    : pl > 0 ? -6 : 0;

    var total = p.solvency + p.strength + p.leverage + p.cashQuality + p.growth + p.governance + p.pledgePenalty;
    total = Math.max(0, Math.min(100, total));
    return { total: Math.round(total), verified: true, parts: p, note: null };
  }

  /* ------------------------------------------------------------------ */
  /* AXIS 2 — AIM SUITABILITY (0-100)                                   */
  /* ------------------------------------------------------------------ */

  /* Asks one question only: would AIM have had work to do here?
   *
   * A superb company that grinds steadily upward scores badly on this axis
   * and should. AIM makes its money from round trips, not from being right
   * about the business.
   *
   * Four components, each with a reason:
   *   oscillation    round trips per year      — direct count of AIM's raw material
   *   amplitude      annualised volatility     — signal size, banded not maximised
   *   recoverySpeed  time to complete a trip   — how long the cash pool is tied up
   *   depth          size of the typical fall  — how much AIM can accumulate into
   *   drift          one-directional decline   — AIM's documented failure mode
   */
  function aimSuitability(a) {
    if (!a) return { total: null, parts: {} };
    var b = a.bounce;
    var p = {};

    // Oscillation (45). Recovered episodes per year, capped at ~1/yr.
    // Rationale: a recovered 20% drawdown IS one complete AIM cycle. This is
    // the most direct measure available of the thing AIM monetises, so it
    // carries the largest weight.
    var years = b.years || 3;
    var recPerYear = years > 0 ? b.recovered / years : 0;
    p.oscillation = Math.round(45 * Math.min(1, recPerYear));

    // Amplitude (25). Banded, not "more is better".
    // Below 15%: too quiet to trigger AIM's 5% midpoint rule often enough.
    // 30-70%: the working band.
    // Above 100%: the moves are large enough that a single adverse leg can
    // drain the shared cash pool before any recovery arrives.
    var v = a.annVol;
    p.amplitude = v < 0.15 ? 0
                : v < 0.30 ? Math.round(18 * (v - 0.15) / 0.15)
                : v <= 0.70 ? 25
                : v <= 1.0 ? Math.round(25 - 15 * (v - 0.70) / 0.30)
                : 5;

    // Depth of the typical completed fall (15).
    // AIM accumulates on the way down, so a round trip that falls further
    // before recovering puts more capital to work at lower prices. Measured
    // only on falls that actually recovered — depth without recovery is a
    // loss, not an opportunity, and is handled by the gates.
    var dp = b.avgBounce;
    p.depth = dp == null ? 0
            : dp >= 0.60 ? 15
            : dp >= 0.35 ? 12
            : dp >= 0.20 ? 8 : 4;

    // Recovery speed (15). Faster round trips free the shared cash pool
    // sooner — which matters more here than usual, because a single pool is
    // shared across every holding. Null when no trip has ever completed.
    var ab = b.avgRecoverBars;
    p.recoverySpeed = ab == null ? 0
                    : ab <= 63 ? 15
                    : ab <= 126 ? 12
                    : ab <= 189 ? 8 : 4;

    // Drift penalty. Sustained one-directional decline is AIM's known
    // weakness: with sells blocked below average cost, the cash pool drains
    // and the position cannot be trimmed. Penalised on this axis explicitly.
    var drift = 0;
    if (a.cagr < -0.15) drift = -20;
    else if (a.cagr < -0.05) drift = -10;
    if (b.open && b.open.drop > 0.40) drift -= 10;
    p.driftPenalty = drift;

    var total = p.oscillation + p.amplitude + p.depth + p.recoverySpeed + p.driftPenalty;
    total = Math.max(0, Math.min(100, total));
    return { total: Math.round(total), parts: p };
  }

  /* ------------------------------------------------------------------ */
  /* Combining the two axes                                             */
  /* ------------------------------------------------------------------ */

  /* Both axes are shown separately in the UI; this is only a sort order.
   *
   * The geometric mean is used on purpose. An arithmetic mean lets a superb
   * score on one axis compensate for a poor score on the other — exactly the
   * trade this screen is meant to refuse. Under a geometric mean, a stock
   * that is weak on either axis cannot rank highly, and a zero on either
   * cannot be rescued at all.
   *
   * Where fundamentals are unavailable the combined figure is withheld
   * rather than guessed, and the entry is marked unverified.
   */
  function combined(quality, aim, m, mk) {
    if (quality.total == null || aim.total == null) return null;
    var c = Math.sqrt(quality.total * aim.total);
    // Very large companies oscillate less in percentage terms; Lichello made
    // the same observation about market leaders.
    if (m && m.marketCap != null && mk && m.marketCap > mk.capTaper) c *= 0.9;
    return Math.round(c);
  }

  // Cheap first-pass ranking on price data alone, to choose the shortlist
  // that gets the expensive deep fetch.
  function prelimScore(a) {
    var s = aimSuitability(a);
    return s.total == null ? 0 : s.total;
  }

  /* Human-readable evidence for every row. The brief is explicit: no acting
   * on a number that cannot be interrogated. */
  function reasons(a, m, mk) {
    var r = [];
    var b = a.bounce;
    if (b.episodes) {
      r.push(b.recovered + " of " + b.episodes + " falls recovered" +
             (b.avgRecoverBars ? " (~" + Math.round(b.avgRecoverBars / 21) + " mo)" : ""));
    }
    r.push("vol " + Math.round(a.annVol * 100) + "%");
    if (b.avgBounce != null) r.push("avg rebound +" + Math.round(b.avgBounce * 100) + "%");
    r.push(Math.round(a.pos * 100) + "% of 52w range");
    r.push("3y " + (a.cagr >= 0 ? "+" : "") + Math.round(a.cagr * 100) + "%/yr");
    if (m) {
      if (m.z != null) r.push("Z " + m.z.toFixed(1));
      if (m.fPct != null) r.push("F " + m.f + "/" + m.fMax);
      if (m.de != null) r.push("D/E " + m.de.toFixed(2));
      if (m.accruals != null) r.push("accruals " + (m.accruals * 100).toFixed(0) + "%");
      if (m.revGrowth != null) r.push("rev " + (m.revGrowth >= 0 ? "+" : "") + Math.round(m.revGrowth * 100) + "%");
      if (m.pledge) r.push("pledged " + m.pledge + "%");
      if (mk.code === "IN" && m.promoterPct != null) r.push("promoter " + Math.round(m.promoterPct) + "%");
    } else r.push("fundamentals unverified");
    return r;
  }


  /* ------------------------------------------------------------------ */
  /* Fundamentals from the universe file                                */
  /* ------------------------------------------------------------------ */

  /* The India universe file carries per-company figures from a Screener.in
   * export: market cap, ROE, debt/equity, interest cover, operating margin,
   * P/E, promoter pledge and promoter holding.
   *
   * This is a WEAKER basis than the balance-sheet route above. It cannot
   * produce an Altman Z (no working capital, retained earnings or total
   * liabilities) or a Piotroski F (no prior-year figures), and it cannot
   * measure accruals (no operating cash flow). Those are the measures with
   * the strongest published out-of-sample support, and they are simply not
   * available here.
   *
   * What it can support is a real but plainer read on profitability,
   * leverage, debt servicing and governance. Anything built from this is
   * marked basis:"universe" so the interface can say so rather than implying
   * a solvency check that did not happen.
   *
   * Note also that the universe was itself gated when it was built
   * (PAT>0, OPM>0, ROE>=6, D/E<1, IntCover>=2, OCF>0, MCap>=1000cr,
   * Pledge<25). Re-applying those same thresholds as gates here would
   * exclude nobody. They are therefore used to SCORE, not to gate, and the
   * figures are as of the universe build date, not today.
   */
  function metricsFromUniverse(u, price) {
    if (!u) return null;
    var m = { basis: "universe" };
    // market cap in the file is in crore for India
    m.marketCap = u.mc != null ? u.mc * 1e7 : null;
    m.roe = u.roe != null ? u.roe / 100 : null;
    m.de = u.de != null ? u.de : null;
    m.intCover = u.ic != null ? u.ic : null;
    m.opm = u.opm != null ? u.opm / 100 : null;
    m.pledge = u.pl != null ? u.pl : null;
    m.promoterPct = u.ph != null ? u.ph : null;
    m.pe = u.pe != null ? u.pe : null;
    m.industry = u.ind || null;

    // Not derivable from this source. Left explicitly null so nothing
    // downstream can mistake absence for a pass.
    m.z = null; m.f = null; m.fMax = null; m.fPct = null;
    m.accruals = null; m.ocfPositive = null; m.ocfBeatsNI = null;
    m.revGrowth = null; m.ebitPositive = null;
    m.profitableEither = true;   // the universe was built from profit-making companies
    m.isFinancial = false;
    m.asOfUniverse = true;
    return m;
  }

  /* Quality on the universe basis (0-100).
   *
   * Deliberately excludes P/E. A low P/E is a statement about price, not
   * about how well the business is run, and this axis is about the business.
   */
  function qualityFromUniverse(m, mk) {
    if (!m) return { total: null, verified: false, parts: {}, basis: "universe", note: "no company data" };
    var p = {};

    // Return on equity (30). Very high ROE is usually a small equity base or
    // leverage rather than excellence, so the band tapers at the top instead
    // of rewarding extremes.
    var r = m.roe;
    p.returns = r == null ? 10
              : r >= 0.40 ? 24
              : r >= 0.25 ? 30
              : r >= 0.18 ? 26
              : r >= 0.12 ? 19
              : r >= 0.08 ? 11 : 4;

    // Operating margin (25). How much of revenue survives the cost of doing
    // business — the plainest available read on pricing power.
    var o = m.opm;
    p.margin = o == null ? 8
             : o >= 0.30 ? 25
             : o >= 0.20 ? 21
             : o >= 0.14 ? 16
             : o >= 0.08 ? 10 : 4;

    // Debt servicing (25). Interest cover is the single best solvency signal
    // available from this source now that Altman Z is out of reach.
    var ic = m.intCover;
    p.servicing = ic == null ? 8
                : ic >= 20 ? 25
                : ic >= 10 ? 21
                : ic >= 5 ? 16
                : ic >= 3 ? 10 : 4;

    // Leverage (20)
    var d = m.de;
    p.leverage = d == null ? 7
               : d <= 0.10 ? 20
               : d <= 0.30 ? 16
               : d <= 0.60 ? 11 : 5;

    // Promoter pledge (penalty). Pledged promoter shares are a forced-selling
    // risk that has nothing to do with the operating business. Scored rather
    // than gated, because the universe was already built with a pledge cut-off
    // and a gate here would never fire.
    var pl = m.pledge;
    p.pledgePenalty = pl == null ? 0
                    : pl >= 20 ? -20
                    : pl >= 10 ? -12
                    : pl > 0 ? -6 : 0;

    // Promoter holding (judgement call, small weight — see notes above).
    var ph = m.promoterPct;
    p.governance = (mk.code !== "IN" || ph == null) ? 0
                 : ph >= 50 ? 0
                 : ph >= 35 ? -4 : -9;

    var total = p.returns + p.margin + p.servicing + p.leverage + p.pledgePenalty + p.governance;
    total = Math.max(0, Math.min(100, total));
    return { total: Math.round(total), verified: true, basis: "universe", parts: p, note: null };
  }

  function reasonsFromUniverse(a, m, mk) {
    var r = [];
    var b = a.bounce;
    if (b.episodes) r.push(b.recovered + " of " + b.episodes + " falls recovered" +
      (b.avgRecoverBars ? " (~" + Math.round(b.avgRecoverBars / 21) + " mo)" : ""));
    if (b.avgBounce != null) r.push("avg rebound +" + Math.round(b.avgBounce * 100) + "%");
    r.push("vol " + Math.round(a.annVol * 100) + "%");
    r.push(Math.round(a.pos * 100) + "% of 52w range");
    r.push("3y " + (a.cagr >= 0 ? "+" : "") + Math.round(a.cagr * 100) + "%/yr");
    if (m) {
      if (m.roe != null) r.push("ROE " + Math.round(m.roe * 100) + "%");
      if (m.opm != null) r.push("margin " + Math.round(m.opm * 100) + "%");
      if (m.intCover != null) r.push("int cover " + (m.intCover >= 100 ? "100+" : m.intCover.toFixed(1)) + "x");
      if (m.de != null) r.push("D/E " + m.de.toFixed(2));
      if (m.pledge) r.push("pledged " + m.pledge + "%");
      if (m.promoterPct != null) r.push("promoter " + Math.round(m.promoterPct) + "%");
    }
    return r;
  }

  root.SelectionEngine = {
    MARKETS: MARKETS,
    analyzeSeries: analyzeSeries,
    bounceStats: bounceStats,
    protectionMetrics: protectionMetrics,
    metricsFromUniverse: metricsFromUniverse,
    qualityFromUniverse: qualityFromUniverse,
    reasonsFromUniverse: reasonsFromUniverse,
    gates: gates,
    qualityScore: qualityScore,
    aimSuitability: aimSuitability,
    combined: combined,
    prelimScore: prelimScore,
    reasons: reasons
  };
})(typeof window !== "undefined" ? window : (typeof module !== "undefined" ? module.exports : this));
