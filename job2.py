"""
Round 2 research on BB 5-min data.
usage: python job2.py <symbols.zip> <universe.csv> <out>
A. Daily / delivery: momentum portfolios, trend-filtered AIM, volatility-scaled AIM.
B. Intraday / MIS: ORB (stocks in play), VWAP reversion, intraday momentum (last 30 min),
   gap fade, and a fitted linear "edge equation" traded only when predicted edge > costs.
Fit = first 2/3 of dates, Test = last 1/3. Only summary tables are written.
"""
import sys, os, re, zipfile, time, warnings
import numpy as np, pandas as pd
from numba import njit
warnings.filterwarnings('ignore')
ZIP, UNI, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
LOG = open(f'{OUT}/log2.txt', 'w')
def log(*a):
    s = ' '.join(map(str, a)); print(s, flush=True); LOG.write(s + '\n'); LOG.flush()
T0 = time.time()

U = pd.read_csv(UNI)
LIQ = set(U[U.med_turnover_cr >= 20].sym)
log('liquid symbols', len(LIQ))

# ---------------- costs ----------------
def mis_rt(V, sc, slip):
    """round-trip cost fraction for an intraday trade of value V. sc: 1 no-brokerage, 2 zerodha"""
    brk = 0.0 if sc == 1 else 2 * min(20.0, 0.0003 * V)
    exch = 2 * 0.0000297 * V; sebi = 2 * 0.000001 * V
    return (brk + 0.00025 * V + exch + sebi + 0.00003 * V + 0.18 * (brk + exch + sebi)) / V + 2 * slip
def cnc_rt(V, slip):
    exch = 2 * 0.0000297 * V
    return (0.002 * V + exch + 0.00015 * V + 0.18 * exch + 15.34) / V + 2 * slip

# ---------------- load ----------------
z = zipfile.ZipFile(ZIP)
names = {}
for i in z.infolist():
    b = os.path.basename(i.filename)
    if b.lower().endswith('.csv'):
        s = re.split(r'_\d+minute', b)[0].upper()
        if s in LIQ: names[s] = i
log('files matched', len(names))

def parse_ts(x):
    x = x.astype(str).str[:19]
    t = pd.to_datetime(x, format='%Y-%m-%d %H:%M:%S', errors='coerce')
    if t.isna().mean() > 0.01: t = pd.to_datetime(x, errors='coerce', format='mixed')
    return t

DAILY = {}      # sym -> daily DataFrame
FEAT = []       # regression rows
TR = []         # intraday trade rows
TIMES = {'09:15': 'f0920', '10:10': 'f1015', '11:25': 'f1130', '12:55': 'f1300', '14:10': 'f1415'}

for n, (s, info) in enumerate(sorted(names.items())):
    try:
        raw = pd.read_csv(z.open(info))
        tcol = [c for c in raw.columns if c.lower() in ('date', 'datetime', 'timestamp', 'time')][0]
        raw.index = parse_ts(raw[tcol]); raw = raw[raw.index.notna()]
        b = raw[['open', 'high', 'low', 'close', 'volume']].astype(float)
        b = b[~b.index.duplicated()].sort_index().between_time('09:15', '15:25')
        b = b[b.index.dayofweek < 5]
    except Exception as e:
        log('skip', s, repr(e)[:120]); continue
    tod = b.index.strftime('%H:%M').values
    day = b.index.normalize()
    g = b.groupby(day)
    D = pd.DataFrame({'o': g.open.first(), 'h': g.high.max(), 'l': g.low.min(), 'c': g.close.last(),
                      'v': g.volume.sum(), 'n': g.size()})
    D = D[D.n >= 60]
    D['pc'] = D.c.shift(1)
    DAILY[s] = D[['o', 'h', 'l', 'c', 'v']]
    # per-day arrays
    days = D.index
    o = b.open.values; h = b.high.values; l = b.low.values; c = b.close.values; v = b.volume.values
    did = pd.Index(days).get_indexer(day)
    tp = (h + l + c) / 3
    # 20-day avg first-bar volume and cumulative-volume curve
    first_vol = pd.Series(v[tod == '09:15'], index=day[tod == '09:15']).reindex(days)
    fv20 = first_vol.shift(1).rolling(14, min_periods=5).mean()
    atr = (D.h - D.l).shift(1).rolling(14, min_periods=5).mean()
    sig = np.log(D.c).diff().shift(1).rolling(20, min_periods=10).std()
    r5 = (D.c.shift(1) / D.c.shift(6) - 1)
    rprev = (D.c.shift(1) / D.c.shift(2) - 1)
    cumv_avg = None
    for j, d in enumerate(days):
        idx = np.where(did == j)[0]
        if len(idx) < 60 or pd.isna(D.pc.iloc[j]): continue
        T = tod[idx]; O = o[idx]; H = h[idx]; L = l[idx]; C = c[idx]; V = v[idx]; TP = tp[idx]
        pc = D.pc.iloc[j]
        try:
            ex = np.where(T == '15:15')[0][0]
        except IndexError:
            continue
        cv = np.cumsum(V); vw = np.cumsum(TP * V) / np.maximum(cv, 1e-9)
        gap = O[0] / pc - 1
        # --- ORB: first 5-min bar direction, enter next bar open, stop at other side of bar0, exit 15:20
        if len(O) > 2 and C[0] != O[0] and not pd.isna(fv20.iloc[j]) and fv20.iloc[j] > 0:
            rvol = V[0] / fv20.iloc[j]
            dirn = 1 if C[0] > O[0] else -1
            e = O[1]; stop = L[0] if dirn == 1 else H[0]
            px = C[ex]; hit = False
            for k in range(1, ex + 1):
                if (dirn == 1 and L[k] <= stop) or (dirn == -1 and H[k] >= stop):
                    px = stop; hit = True; break
            TR.append((d, s, 'ORB', dirn * (px / e - 1), rvol, gap, hit))
        # --- gap fade: short at 9:20 close, cover 15:20
        TR.append((d, s, 'GAPFADE', -(C[ex] / C[0] - 1), np.nan, gap, False))
        # --- intraday momentum: sign(prev close -> 14:50) traded 14:50 -> 15:20
        k1450 = np.where(T == '14:45')[0]
        if len(k1450):
            k = k1450[0]; rf = C[k] / pc - 1
            TR.append((d, s, 'LATEMOM', np.sign(rf) * (C[ex] / C[k] - 1), rf, gap, False))
        # --- VWAP reversion: first time close deviates beyond thr from VWAP after 9:45, revert to VWAP or exit 15:20
        for thr in (0.01, 0.015, 0.02, 0.03):
            for side in (1, -1):
                ent = -1
                for k in range(6, ex):
                    dev = C[k] / vw[k] - 1
                    if (side == 1 and dev <= -thr) or (side == -1 and dev >= thr):
                        ent = k; break
                if ent < 0: continue
                e = C[ent]; px = C[ex]
                for k in range(ent + 1, ex + 1):
                    if (side == 1 and H[k] >= vw[k - 1]) or (side == -1 and L[k] <= vw[k - 1]):
                        px = vw[k - 1]; break
                TR.append((d, s, f'VWAP{int(thr*1000)}_{"L" if side==1 else "S"}', side * (px / e - 1), thr, gap, False))
        # --- regression features at decision times, target = return to 15:20
        for t, nm in TIMES.items():
            kk = np.where(T == t)[0]
            if not len(kk): continue
            k = kk[0]
            if k >= ex: continue
            FEAT.append((d, s, nm, gap, C[k] / O[0] - 1, C[k] / pc - 1, C[k] / vw[k] - 1,
                         cv[k] / max(fv20.iloc[j] * (k + 1), 1e-9) if not pd.isna(fv20.iloc[j]) else np.nan,
                         rprev.iloc[j], r5.iloc[j], sig.iloc[j], C[ex] / C[k] - 1, C[k]))
    if n % 50 == 0: log('loaded', n, s, round(time.time() - T0))
log('loaded all', len(DAILY), round(time.time() - T0))

dates = sorted(set().union(*[set(d.index) for d in DAILY.values()]))
CUT = dates[int(len(dates) * 2 / 3)]
log('fit until', CUT.date(), 'test after')
rep = [f'# Round 2 — BB data {dates[0].date()} to {dates[-1].date()}, {len(DAILY)} liquid stocks (>= Rs 20 cr/day)',
       f'Fit = up to {CUT.date()}, Test = after (unseen).\n']

# =============== B. intraday =================
TRd = pd.DataFrame(TR, columns=['d', 's', 'strat', 'r', 'x', 'gap', 'stop'])
TRd['per'] = np.where(TRd.d < CUT, 'fit', 'test')
def evaluate(sel, label, rows, V=2e5):
    """sel: DataFrame of trades (one row per trade). equal capital per trade; daily portfolio = mean of that day's trades."""
    for sc, scn in [(1, 'no-brokerage'), (2, 'zerodha')]:
        for slip in (0.0003, 0.0005):
            cst = mis_rt(V, sc, slip)
            for per in ('fit', 'test'):
                x = sel[sel.per == per]
                if len(x) < 30: continue
                net = x.r - cst
                dly = net.groupby(x.d).mean()
                eq = (1 + dly).cumprod(); yrs = len(dates) / 248 * (len(dly) and (1 if per == 'fit' else 0.5) or 1)
                rows.append(dict(strategy=label, costs=scn, slip_pct=slip * 100, per=per, trades=len(x),
                                 gross_per_trade=x.r.mean() * 100, net_per_trade=net.mean() * 100,
                                 win=(net > 0).mean() * 100, t=dly.mean() / dly.std() * np.sqrt(len(dly)) if dly.std() > 0 else 0,
                                 days=len(dly), avg_day=dly.mean() * 100, maxDD=(eq / eq.cummax() - 1).min() * 100))
rows = []
# ORB stocks-in-play: top K by relative volume with rvol>1 (Zarattini-style)
orb = TRd[TRd.strat == 'ORB'].copy()
orb['rk'] = orb.groupby('d').x.rank(ascending=False)
for K in (5, 10, 20):
    for rv in (1.0, 2.0):
        evaluate(orb[(orb.rk <= K) & (orb.x >= rv)], f'ORB top{K} rvol>={rv}', rows)
gf = TRd[TRd.strat == 'GAPFADE'].copy(); gf['rk'] = gf.groupby('d').gap.rank(ascending=False)
for K in (1, 3, 5): evaluate(gf[gf.rk <= K], f'GapFade top{K}', rows)
lm = TRd[TRd.strat == 'LATEMOM']
for th in (0.0, 0.01, 0.02):
    evaluate(lm[lm.x.abs() >= th], f'LateMomentum |r|>={th}', rows)
for st in sorted(TRd.strat.unique()):
    if st.startswith('VWAP'): evaluate(TRd[TRd.strat == st], st, rows)
B = pd.DataFrame(rows).round(3)
B.to_csv(f'{OUT}/intraday_round2.csv', index=False)
key = B[(B.costs == 'zerodha') & (B.slip_pct == 0.03)].pivot_table(index='strategy', columns='per',
        values=['trades', 'gross_per_trade', 'net_per_trade', 'win', 't', 'avg_day', 'maxDD'])
rep.append('## B1. Intraday strategies (Zerodha MIS costs, Rs 2L per trade, 0.03% slippage/side)\n')
rep.append(key.round(3).to_string())
rep.append('\nSame with NO brokerage (taxes only):\n')
rep.append(B[(B.costs == 'no-brokerage') & (B.slip_pct == 0.03)].pivot_table(index='strategy', columns='per',
           values=['net_per_trade', 't']).round(3).to_string())

# ---- fitted edge equation (linear regression, fit period only) ----
F = pd.DataFrame(FEAT, columns=['d', 's', 'when', 'gap', 'r_open', 'r_pc', 'vwapdev', 'rvol', 'rprev', 'r5', 'sig', 'y', 'px'])
F = F.replace([np.inf, -np.inf], np.nan).dropna()
for c in ['gap', 'r_open', 'r_pc', 'vwapdev', 'rprev', 'r5']: F[c] = F[c].clip(-0.2, 0.2)
F['rvol'] = np.log(F.rvol.clip(0.05, 50)); F['y'] = F.y.clip(-0.2, 0.2)
X = ['gap', 'r_open', 'vwapdev', 'rvol', 'rprev', 'r5', 'sig']
eq_rows = []; coef_txt = []
for w in TIMES.values():
    f = F[F.when == w]; fit = f[f.d < CUT]; tst = f[f.d >= CUT]
    if len(fit) < 1000: continue
    A = np.c_[np.ones(len(fit)), fit[X].values, fit[X].values * fit[['sig']].values]
    lam = 1e-4 * len(fit)
    beta = np.linalg.solve(A.T @ A + lam * np.eye(A.shape[1]), A.T @ fit.y.values)
    coef_txt.append(f'{w}: y = ' + ' + '.join(f'{b:.4f}*{n}' for b, n in zip(beta, ['1'] + X + [x + '*sig' for x in X])))
    for per, ff in (('fit', fit), ('test', tst)):
        Aa = np.c_[np.ones(len(ff)), ff[X].values, ff[X].values * ff[['sig']].values]
        pred = Aa @ beta
        ic = np.corrcoef(pred, ff.y)[0, 1]
        for thr_mult in (1.0, 1.5, 2.0):
            cst = mis_rt(2e5, 2, 0.0003)
            m = np.abs(pred) > thr_mult * cst
            if m.sum() < 30: continue
            r = np.sign(pred[m]) * ff.y.values[m] - cst
            dly = pd.Series(r, index=ff.d.values[m]).groupby(level=0).mean()
            eq = (1 + dly).cumprod()
            eq_rows.append(dict(when=w, per=per, edge_x_cost=thr_mult, IC=ic, trades=int(m.sum()), net_per_trade=r.mean() * 100,
                                win=(r > 0).mean() * 100, t=dly.mean() / dly.std() * np.sqrt(len(dly)) if dly.std() > 0 else 0,
                                maxDD=(eq / eq.cummax() - 1).min() * 100))
E = pd.DataFrame(eq_rows).round(4); E.to_csv(f'{OUT}/edge_equation.csv', index=False)
rep.append('\n## B2. Fitted edge equation (ridge regression on fit period; trade only when |predicted move| > k x cost; Zerodha costs)\n')
if len(E): rep.append(E.pivot_table(index=['when', 'edge_x_cost'], columns='per', values=['IC', 'trades', 'net_per_trade', 't', 'maxDD']).round(4).to_string())
rep.append('\nEquations (fit period):\n' + '\n'.join(coef_txt))
log('intraday done', round(time.time() - T0))

# =============== A. daily: momentum, trend AIM, vol AIM =================
C = pd.DataFrame({s: d.c for s, d in DAILY.items()}).sort_index()
C = C.loc[:, C.notna().mean() > 0.8]
rets = C.pct_change()
rowsA = []
def port_stats(dr, label, per):
    dr = dr.dropna()
    if per == 'fit': dr = dr[dr.index < CUT]
    elif per == 'test': dr = dr[dr.index >= CUT]
    if len(dr) < 30: return
    eq = (1 + dr).cumprod(); yrs = len(dr) / 248
    rowsA.append(dict(strategy=label, per=per, CAGR=(eq.iloc[-1] ** (1 / yrs) - 1) * 100, vol=dr.std() * np.sqrt(248) * 100,
                      maxDD=(eq / eq.cummax() - 1).min() * 100))
ew = rets.mean(axis=1)
for per in ('fit', 'test', 'all'): port_stats(ew, 'Equal-weight all liquid (benchmark)', per)
for LB in (63, 126, 189):
    for N in (20, 30):
        mom = C.shift(5) / C.shift(LB) - 1
        w = pd.DataFrame(0.0, index=C.index, columns=C.columns); cur = None; turn = pd.Series(0.0, index=C.index)
        for i, d in enumerate(C.index):
            if i >= LB + 5 and (i - LB - 5) % 21 == 0:
                top = mom.loc[d].dropna().nlargest(N).index
                new = pd.Series(0.0, index=C.columns); new[top] = 1.0 / N
                turn[d] = (new - (cur if cur is not None else 0)).abs().sum() / 2 if cur is not None else 1
                cur = new
            if cur is not None: w.loc[d] = cur
        pr = (w.shift(1) * rets).sum(axis=1) - turn.shift(1).fillna(0) * cnc_rt(1e5, 0.0005)
        pr = pr[pr.index >= C.index[LB + 6]]
        for per in ('fit', 'test', 'all'): port_stats(pr, f'Momentum {LB}d top{N} monthly', per)

@njit(cache=True)
def aim_daily(c, check, safe_arr, buy_ok, cap, slip):
    cash = cap; px = c[0] * (1 + slip); sh = np.floor(cap * 0.5 / px); cash -= sh * px * 1.0012; pc = sh * c[0]; avg = px
    eq = np.zeros(len(c)); eq[0] = cash + sh * c[0]
    for i in range(1, len(c)):
        if check[i] and not np.isnan(safe_arr[i]):
            val = sh * c[i]; E = cash + val; adv = pc - val; sf = safe_arr[i] * val
            if adv > sf and buy_ok[i]:
                amt = min(adv - sf, cash, 0.95 * E - val)
                if amt >= 5000:
                    p = c[i] * (1 + slip); q = np.floor(amt / p); v = q * p; cash -= v * 1.0012 + 0.0; avg = (avg * sh + v) / (sh + q); sh += q; pc += 0.5 * v
            elif -adv > sf and c[i] > avg:
                amt = -adv - sf
                if amt >= 5000:
                    p = c[i] * (1 - slip); q = min(np.floor(amt / p), sh); v = q * p; cash += v * (1 - 0.0011) - 15.34; sh -= q
        eq[i] = cash + sh * c[i]
    return eq
aimv = {}
for s in C.columns:
    c = C[s].ffill().dropna()
    if len(c) < 200: continue
    cv = c.values.astype(np.float64); n = len(cv)
    chk = (np.arange(n) % 10 == 0)
    sig = np.log(c).diff().rolling(20).std().values * np.sqrt(10)
    ma = c.rolling(100, min_periods=50).mean().values
    up = np.nan_to_num(cv > ma, nan=1).astype(np.bool_)
    tr = np.ones(n, np.bool_)
    variants = {'AIM biweekly (current app)': (np.full(n, 0.10), tr),
                'AIM + trend filter (no buys below 100d avg)': (np.full(n, 0.10), up)}
    for k in (1.0, 1.5, 2.0):
        variants[f'AIM vol-scaled safe={k}x 2wk vol'] = (k * sig, tr)
        variants[f'AIM vol-scaled {k}x + trend filter'] = (k * sig, up)
    for nm, (sa, bo) in variants.items():
        aimv.setdefault(nm, {})[s] = pd.Series(aim_daily(cv, chk, sa.astype(np.float64), bo, 1e6, 0.0005), index=c.index)
    bh = c / c.iloc[0]
    aimv.setdefault('Buy & hold (same stocks)', {})[s] = bh * 1e6
for nm, d in aimv.items():
    P = pd.DataFrame(d)
    dr = P.pct_change().mean(axis=1)
    for per in ('fit', 'test', 'all'): port_stats(dr, nm, per)
    # per-stock median CAGR
    yrs = len(P) / 248
    med = ((P.ffill().iloc[-1] / 1e6) ** (1 / yrs) - 1).median() * 100
    mdd = (P / P.cummax() - 1).min().median() * 100
    rowsA.append(dict(strategy=nm, per='per-stock median', CAGR=med, vol=np.nan, maxDD=mdd))
A = pd.DataFrame(rowsA).round(2); A.to_csv(f'{OUT}/daily_round2.csv', index=False)
rep.insert(2, '## A. Daily strategies (delivery costs incl. STT, 0.05% slippage)\n' +
           A.pivot_table(index='strategy', columns='per', values=['CAGR', 'maxDD']).round(2).to_string() + '\n')
open(f'{OUT}/REPORT2.md', 'w').write('\n'.join(rep))
log('DONE', round(time.time() - T0))
