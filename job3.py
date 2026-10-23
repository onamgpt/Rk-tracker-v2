"""
Round 3 on BB 5-min data.  usage: python job3.py <symbols.zip> <universe.csv> <out>
1. AIM parameter sweep (safe %, check frequency, PC increment, sell-block) on the 150 most liquid stocks.
2. Swing box -> AIM hybrid: buy at 15:20 on a signal (MTF margin), sell at a profit target within H days;
   if the target is not hit, either sell at day H close, or hand the position to long-term AIM (held 20 / 60 more days).
Costs: delivery (STT 0.1% each side, stamp, exchange, GST, DP), 0.03% slippage/side, MTF interest 0.04%/day on 80% funded.
Fit = first 2/3 of dates, Test = last 1/3.
"""
import sys, os, re, zipfile, time, warnings
import numpy as np, pandas as pd
from numba import njit
warnings.filterwarnings('ignore')
ZIP, UNI, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
LOG = open(f'{OUT}/log3.txt', 'w')
def log(*a):
    s = ' '.join(map(str, a)); print(s, flush=True); LOG.write(s + '\n'); LOG.flush()
T0 = time.time()
U = pd.read_csv(UNI)
LIQ = U[U.med_turnover_cr >= 20].sort_values('med_turnover_cr', ascending=False)
LIQSET = set(LIQ.sym); TOP150 = list(LIQ.sym[:150])
z = zipfile.ZipFile(ZIP); names = {}
for i in z.infolist():
    b = os.path.basename(i.filename)
    if b.lower().endswith('.csv'):
        s = re.split(r'_\d+minute', b)[0].upper()
        if s in LIQSET: names[s] = i
DAY = {}
for n, (s, info) in enumerate(sorted(names.items())):
    try:
        raw = pd.read_csv(z.open(info))
        tcol = [c for c in raw.columns if c.lower() in ('date', 'datetime', 'timestamp', 'time')][0]
        x = raw[tcol].astype(str).str[:19]
        t = pd.to_datetime(x, format='%Y-%m-%d %H:%M:%S', errors='coerce')
        if t.isna().mean() > 0.01: t = pd.to_datetime(x, errors='coerce', format='mixed')
        raw.index = t; raw = raw[raw.index.notna()]
        b = raw[['open', 'high', 'low', 'close', 'volume']].astype(float)
        b = b[~b.index.duplicated()].sort_index().between_time('09:15', '15:25'); b = b[b.index.dayofweek < 5]
    except Exception as e:
        log('skip', s, repr(e)[:100]); continue
    tod = b.index.strftime('%H:%M'); d = b.index.normalize(); g = b.groupby(d)
    D = pd.DataFrame({'o': g.open.first(), 'h': g.high.max(), 'l': g.low.min(), 'c': g.close.last(), 'n': g.size()})
    c920 = b.close[tod == '09:15']; c920.index = c920.index.normalize()
    c1520 = b.close[tod == '15:15']; c1520.index = c1520.index.normalize()
    D['c920'] = c920; D['c1520'] = c1520
    D = D[(D.n >= 60)].dropna()
    DAY[s] = D
    if n % 100 == 0: log('loaded', n, round(time.time() - T0))
log('stocks', len(DAY))
dates = sorted(set().union(*[set(d.index) for d in DAY.values()])); CUT = dates[int(len(dates) * 2 / 3)]
rep = [f'# Round 3 — {dates[0].date()} to {dates[-1].date()}, {len(DAY)} liquid stocks. Fit < {CUT.date()} <= Test\n']

# ---------------- 1. AIM sweep ----------------
@njit(cache=True)
def aim(c, every, safe, pcinc, block, slip):
    cap = 1e6; px = c[0] * (1 + slip); sh = np.floor(cap * 0.5 / px); cash = cap - sh * px * 1.0012; pc = sh * c[0]; avg = px
    eq = np.zeros(len(c)); eq[0] = cash + sh * c[0]; ntr = 0
    for i in range(1, len(c)):
        if i % every == 0:
            val = sh * c[i]; E = cash + val; adv = pc - val; sf = safe * val
            if adv > sf:
                amt = min(adv - sf, cash, 0.95 * E - val)
                if amt >= 5000:
                    p = c[i] * (1 + slip); q = np.floor(amt / p)
                    if q > 0:
                        v = q * p; cash -= v * 1.0012; avg = (avg * sh + v) / (sh + q); sh += q; pc += pcinc * v; ntr += 1
            elif -adv > sf and (block == 0 or c[i] > avg):
                amt = -adv - sf
                if amt >= 5000:
                    p = c[i] * (1 - slip); q = min(np.floor(amt / p), sh)
                    if q > 0:
                        v = q * p; cash += v * (1 - 0.0011) - 15.34; sh -= q; ntr += 1
        eq[i] = cash + sh * c[i]
    return eq, ntr
rows = []
cutpos = {}
for s in TOP150:
    if s not in DAY: continue
    D = DAY[s]; c = D.c1520.values.astype(np.float64); idx = D.index
    k = np.searchsorted(idx.values, np.datetime64(CUT))
    yrs = len(c) / 248
    bh = c / c[0]
    rows.append(dict(sym=s, every=0, safe=0, pcinc=0, block=0, CAGR=(bh[-1] ** (1 / yrs) - 1) * 100,
                     DD=(bh / np.maximum.accumulate(bh) - 1).min() * 100, test=(c[-1] / c[k] - 1) * 100 if k < len(c) else np.nan, trades=0))
    for every in (1, 5, 10, 21):
        for safe in (0.0, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15):
            for pcinc in (0.5, 1.0):
                for block in (0, 1):
                    eq, ntr = aim(c, every, safe, pcinc, block, 0.0003)
                    rows.append(dict(sym=s, every=every, safe=safe, pcinc=pcinc, block=block, CAGR=((eq[-1] / 1e6) ** (1 / yrs) - 1) * 100,
                                     DD=(eq / np.maximum.accumulate(eq) - 1).min() * 100,
                                     test=(eq[-1] / eq[k] - 1) * 100 if k < len(c) else np.nan, trades=ntr))
A = pd.DataFrame(rows)
S = A.groupby(['every', 'safe', 'pcinc', 'block']).agg(med_CAGR=('CAGR', 'median'), mean_CAGR=('CAGR', 'mean'), med_DD=('DD', 'median'),
                                                       med_test_ret=('test', 'median'), trades=('trades', 'median')).round(2).reset_index()
S['return_per_DD'] = (S.med_CAGR / -S.med_DD).round(3)
S.to_csv(f'{OUT}/aim_sweep.csv', index=False)
rep.append('## 1. AIM parameter sweep (150 most liquid, Rs 10L each, delivery costs). every = check every N trading days (0 = buy & hold)\n')
rep.append('Top 15 by median CAGR:\n' + S.sort_values('med_CAGR', ascending=False).head(15).to_string(index=False))
rep.append('\nTop 15 by return per unit of drawdown:\n' + S[S.every > 0].sort_values('return_per_DD', ascending=False).head(15).to_string(index=False))
rep.append('\nYour current app (every 10, safe 10%, pc 0.5, sell-block on):\n' + S[(S.every == 10) & (S.safe == 0.10) & (S.pcinc == 0.5) & (S.block == 1)].to_string(index=False))
rep.append('\nBuy & hold:\n' + S[S.every == 0].to_string(index=False))
log('aim sweep done', round(time.time() - T0))

# ---------------- 2. Swing box -> AIM ----------------
SLIP = 0.0003
def cnc_cost(V=1e5):
    exch = 2 * 0.0000297 * V
    return (0.002 * V + exch + 0.00015 * V + 0.18 * exch + 15.34) / V + 2 * SLIP
CC = cnc_cost()
MTF_DAY = 0.0004 * 0.8 * 1.4     # 0.04%/day on 80% funded, ~1.4 calendar days per trading day
TGTS = (0.005, 0.01, 0.015, 0.02, 0.03); HS = (1, 3, 5)
recs = []
for s, D in DAY.items():
    o = D.o.values; h = D.h.values; c = D.c1520.values; cl = D.c.values; n = len(D)
    pc = np.r_[np.nan, cl[:-1]]
    r_day = c / pc - 1                         # prev close -> 15:20 today
    ma100 = pd.Series(cl).rolling(100, min_periods=50).mean().values
    rng = (c - D.l.values) / np.maximum(D.h.values - D.l.values, 1e-9)
    for i in range(1, n - 1):
        E = c[i] * (1 + SLIP)
        row = [D.index[i], s, r_day[i], c[i] > ma100[i] if not np.isnan(ma100[i]) else False, rng[i]]
        for H in HS:
            last = min(i + H, n - 1)
            for T in TGTS:
                tgt = E * (1 + T); hit = 0; ex = None; held = 0
                for j in range(i + 1, last + 1):
                    held = j - i
                    if o[j] >= tgt: ex = o[j]; hit = 1; break
                    if h[j] >= tgt: ex = tgt; hit = 1; break
                if not hit:
                    ex = c[last] * (1 - SLIP); held = last - i
                ret_sell = ex / E - 1 - CC - MTF_DAY * held
                # fail -> AIM proxy: keep holding (no margin; AIM pool cash) 20 / 60 more trading days
                if hit:
                    r20 = r60 = ret_sell
                else:
                    j20 = min(last + 20, n - 1); j60 = min(last + 60, n - 1)
                    r20 = c[j20] * (1 - SLIP) / E - 1 - CC - MTF_DAY * held
                    r60 = c[j60] * (1 - SLIP) / E - 1 - CC - MTF_DAY * held
                row += [hit, ret_sell, r20, r60]
        recs.append(row)
cols = ['d', 's', 'r_day', 'uptrend', 'range_pos']
for H in HS:
    for T in TGTS: cols += [f'hit_{H}_{T}', f'sell_{H}_{T}', f'aim20_{H}_{T}', f'aim60_{H}_{T}']
R = pd.DataFrame(recs, columns=cols)
R['xs_rank'] = R.groupby('d').r_day.rank()     # 1 = worst performer today
R['per'] = np.where(R.d < CUT, 'fit', 'test')
log('swing table', len(R), round(time.time() - T0))
SIG = {'Every stock, every day (random)': R.index == R.index,
       'Fell >= 2% today': R.r_day <= -0.02,
       'Fell >= 3% today': R.r_day <= -0.03,
       'Fell >= 2% today, in uptrend (above 100d avg)': (R.r_day <= -0.02) & R.uptrend,
       '10 worst stocks today': R.xs_rank <= 10,
       '10 worst stocks today, in uptrend': (R.xs_rank <= 10) & R.uptrend,
       'Closed near day low, in uptrend': (R.range_pos <= 0.1) & R.uptrend}
out = []
for nm, m in SIG.items():
    for H in HS:
        for T in TGTS:
            for per in ('fit', 'test'):
                x = R[m & (R.per == per)]
                if len(x) < 50: continue
                for mode, col in (('sell at day-H close', f'sell_{H}_{T}'), ('fail -> AIM 20d', f'aim20_{H}_{T}'), ('fail -> AIM 60d', f'aim60_{H}_{T}')):
                    v = x[col]
                    dly = v.groupby(x.d).mean()
                    out.append(dict(signal=nm, hold_days=H, target_pct=T * 100, mode=mode, per=per, trades=len(x),
                                    hit_rate=x[f'hit_{H}_{T}'].mean() * 100, avg_net=v.mean() * 100, median=v.median() * 100,
                                    worst5pct=v.quantile(0.05) * 100, t=dly.mean() / dly.std() * np.sqrt(len(dly)) if dly.std() > 0 else 0))
O = pd.DataFrame(out).round(3); O.to_csv(f'{OUT}/swing_box.csv', index=False)
P = O.pivot_table(index=['signal', 'mode', 'hold_days', 'target_pct'], columns='per', values=['trades', 'hit_rate', 'avg_net', 't'])
P.columns = [f'{a}_{b}' for a, b in P.columns]
P = P.reset_index()
good = P[(P.avg_net_fit > 0) & (P.avg_net_test > 0)].sort_values('avg_net_test', ascending=False)
rep.append(f'\n## 2. Swing box -> AIM (delivery costs {CC*100:.3f}% round trip + MTF interest {MTF_DAY*100:.3f}%/day held)\n')
rep.append('Combinations profitable in BOTH fit and test (top 40 by test avg net % per trade):\n' + good.head(40).round(3).to_string(index=False))
rep.append('\nBaseline (random entry), sell mode:\n' + P[(P.signal.str.startswith('Every')) & (P['mode'] == 'sell at day-H close')].round(3).to_string(index=False))
open(f'{OUT}/REPORT3.md', 'w').write('\n'.join(rep))
log('DONE', round(time.time() - T0))
