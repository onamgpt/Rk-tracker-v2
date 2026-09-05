// Background function (15-min limit): builds a fundamentals table for the whole
// US market from SEC EDGAR's XBRL "frames" API — one call per concept returns
// every filer's value for a period — and stores it in the kv table as
// pf_us_fundamentals. The synchronous reader in db.js (getPortfolio, key
// us_fundamentals) serves it to the screener. Official, free, no API key;
// SEC asks for a descriptive User-Agent and ≤10 req/s, which we respect.
//
// Rebuilt only when older than 7 days — fundamentals move quarterly, and the
// screener runs on top of prices that move daily, so this is the right cadence.

export default async (req) => {
  const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
  const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
  const UA = "RKTrading/1.0 (onamagarbathi@gmail.com)";
  const sbH = { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" };


  const tgNotify = async (text) => {
    try {
      const bot = Netlify.env.get("TELEGRAM_BOT_TOKEN"), chat = Netlify.env.get("TELEGRAM_CHAT_ID");
      if (!bot || !chat) return;
      await fetch("https://api.telegram.org/bot" + bot + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: text, parse_mode: "HTML" }) });
    } catch (e) {}
  };

  let force = false;
  try { const b = await req.json(); force = !!(b && b.force); } catch (e) {}

  const status = async (obj) => {
    await fetch(SUPABASE_URL + "/rest/v1/kv?on_conflict=owner,k", {
      method: "POST", headers: Object.assign({ "Prefer": "resolution=merge-duplicates,return=minimal" }, sbH),
      body: JSON.stringify({ owner: "main", k: "pf_us_fund_job", v: Object.assign({ at: new Date().toISOString() }, obj) })
    });
  };

  try {
    // Skip if fresh
    if (!force) {
      const r = await fetch(SUPABASE_URL + "/rest/v1/kv?owner=eq.main&k=eq.pf_us_fundamentals&select=v", { headers: sbH });
      const j = await r.json();
      const cur = Array.isArray(j) && j[0] && j[0].v;
      if (cur && cur.builtAt && (Date.now() - new Date(cur.builtAt).getTime()) < 7 * 86400000) {
        await status({ state: "done", note: "cache fresh", count: cur.count });
        return new Response(JSON.stringify({ ok: true, cached: true }), { status: 200 });
      }
    }
    await status({ state: "running", step: "tickers" });

    // Ticker → CIK map (first ticker wins per CIK)
    const tRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": UA, "Accept": "application/json" } });
    const tJson = await tRes.json();
    const cikToTicker = {};
    Object.values(tJson).forEach(x => { if (x && x.cik_str && x.ticker && !cikToTicker[x.cik_str]) cikToTicker[x.cik_str] = x.ticker; });

    // Which frames to read. Duration concepts: last complete calendar year and
    // the one before. Instant concepts: latest quarter-ends with broad coverage.
    const now = new Date();
    const y = now.getUTCFullYear();
    const FY = "CY" + (y - 1), FYP = "CY" + (y - 2);
    const q = Math.floor(now.getUTCMonth() / 3); // 0..3
    const inst = [];
    // most recent quarter that has had ~45 days to be reported, then fallbacks
    for (let k = 1; k <= 4; k++) {
      let qq = q - k, yy = y;
      while (qq < 0) { qq += 4; yy -= 1; }
      inst.push("CY" + yy + "Q" + (qq + 1) + "I");
    }
    const instPrior = "CY" + (y - 2) + "Q4I";

    const frame = async (tax, tag, unit, period) => {
      const url = "https://data.sec.gov/api/xbrl/frames/" + tax + "/" + tag + "/" + unit + "/" + period + ".json";
      try {
        const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
        if (!r.ok) return {};
        const j = await r.json();
        const out = {};
        (j.data || []).forEach(d => { if (d && d.cik != null && typeof d.val === "number") out[d.cik] = d.val; });
        return out;
      } catch (e) { return {}; }
    };
    const merge = (list) => { const o = {}; list.forEach(m => Object.keys(m).forEach(c => { if (o[c] == null) o[c] = m[c]; })); return o; };
    const pool = async (tasks, n) => {
      const res = new Array(tasks.length); let i = 0;
      await Promise.all(new Array(n).fill(0).map(async () => { while (i < tasks.length) { const k = i++; res[k] = await tasks[k](); } }));
      return res;
    };

    await status({ state: "running", step: "frames" });

    // Every frame request is keyed by name — no positional index arithmetic,
    // so a field can never silently receive another field's numbers.
    const jobs = {};
    const add = (key, tax, tag, unit, period) => { jobs[key] = () => frame(tax, tag, unit, period); };
    ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"].forEach((t, k) => { add("rev" + k, "us-gaap", t, "USD", FY); add("revP" + k, "us-gaap", t, "USD", FYP); });
    add("ni", "us-gaap", "NetIncomeLoss", "USD", FY); add("niP", "us-gaap", "NetIncomeLoss", "USD", FYP);
    add("ebit", "us-gaap", "OperatingIncomeLoss", "USD", FY);
    add("ocf", "us-gaap", "NetCashProvidedByUsedInOperatingActivities", "USD", FY);
    add("interest", "us-gaap", "InterestExpense", "USD", FY);
    const instTags = ["Assets", "Liabilities", "StockholdersEquity", "AssetsCurrent", "LiabilitiesCurrent", "LongTermDebtNoncurrent", "LongTermDebt", "RetainedEarningsAccumulatedDeficit"];
    instTags.forEach(t => inst.forEach((p, k) => add(t + "@" + k, "us-gaap", t, "USD", p)));
    add("assetsPrior", "us-gaap", "Assets", "USD", instPrior);
    add("ltdPriorA", "us-gaap", "LongTermDebtNoncurrent", "USD", instPrior);
    add("ltdPriorB", "us-gaap", "LongTermDebt", "USD", instPrior);
    inst.forEach((p, k) => add("shares@" + k, "dei", "EntityCommonStockSharesOutstanding", "shares", p));
    add("sharesPrior", "dei", "EntityCommonStockSharesOutstanding", "shares", instPrior);

    const keys = Object.keys(jobs);
    const results = await pool(keys.map(k => jobs[k]), 4); // 4-way parallel: well under SEC's 10 req/s
    const G = {}; keys.forEach((k, idx) => { G[k] = results[idx] || {}; });
    const pick = (prefix) => merge(inst.map((_, k) => G[prefix + "@" + k]));

    const rev = merge([G.rev0, G.rev1, G.rev2]), revP = merge([G.revP0, G.revP1, G.revP2]);
    const ni = G.ni, niP = G.niP, ebit = G.ebit, ocf = G.ocf, interest = G.interest;
    const instMaps = {}; instTags.forEach(t => { instMaps[t] = pick(t); });
    const assetsPrior = G.assetsPrior;
    const ltdPrior = merge([G.ltdPriorA, G.ltdPriorB]);
    const shares = pick("shares");
    const sharesPrior = G.sharesPrior;
    const ltd = merge([instMaps.LongTermDebtNoncurrent, instMaps.LongTermDebt]);

    const table = {};
    const ciks = new Set([...Object.keys(instMaps.Assets), ...Object.keys(rev), ...Object.keys(ni)]);
    ciks.forEach(c => {
      const t = cikToTicker[c]; if (!t) return;
      table[t] = {
        rev: rev[c] ?? null, revPrior: revP[c] ?? null,
        ni: ni[c] ?? null, niPrior: niP[c] ?? null,
        ebit: ebit[c] ?? null, ocf: ocf[c] ?? null, interest: interest[c] ?? null,
        assets: instMaps.Assets[c] ?? null, assetsPrior: assetsPrior[c] ?? null,
        liab: instMaps.Liabilities[c] ?? null, equity: instMaps.StockholdersEquity[c] ?? null,
        curAssets: instMaps.AssetsCurrent[c] ?? null, curLiab: instMaps.LiabilitiesCurrent[c] ?? null,
        ltd: ltd[c] ?? null, ltdPrior: ltdPrior[c] ?? null,
        retained: instMaps.RetainedEarningsAccumulatedDeficit[c] ?? null,
        shares: shares[c] ?? null, sharesPrior: sharesPrior[c] ?? null
      };
    });

    const payload = { builtAt: new Date().toISOString(), frames: { FY, FYP, inst }, count: Object.keys(table).length, data: table };
    await fetch(SUPABASE_URL + "/rest/v1/kv?on_conflict=owner,k", {
      method: "POST", headers: Object.assign({ "Prefer": "resolution=merge-duplicates,return=minimal" }, sbH),
      body: JSON.stringify({ owner: "main", k: "pf_us_fundamentals", v: payload })
    });
    await status({ state: "done", count: payload.count, frames: payload.frames });
    await tgNotify("🇺🇸 <b>US fundamentals table built</b>\n" + payload.count + " companies from SEC EDGAR · frames " + FY + " / " + inst[0] + "\nCached 7 days — the USA screener's quality stage is now instant.");
    return new Response(JSON.stringify({ ok: true, count: payload.count }), { status: 200 });
  } catch (e) {
    await status({ state: "error", error: String(e && e.message || e) });
    await tgNotify("🇺🇸 <b>US fundamentals build FAILED</b>\n" + String(e && e.message || e).slice(0, 200));
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 200 });
  }
};
