"""
Round 4: classic daily technical-analysis rules on BB data (long only, delivery/CNC costs).
usage: python job4.py <symbols.zip> <universe.csv> <out>
Signals computed on the 15:20 price, trades entered/exited at 15:20. Portfolio = equal weight across open positions.
"""
import sys, os, re, zipfile, time, warnings
import numpy as np, pandas as pd
warnings.filterwarnings('ignore')
ZIP, UNI, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
LOG = open(f'{OUT}/log4.txt', 'w')
def log(*a):
    s = ' '.join(map(str, a)); print(s, flush=True); LOG.write(s + '\n'); LOG.flush()
T0 = time.time()
U = pd.read_csv(UNI); LIQ = set(U[U.med_turnover_cr >= 20].sym)
z = zipfile.ZipFile(ZIP); names = {}
for i in z.infolist():
    b = os.path.basename(i.filename)
    if b.lower().endswith('.csv'):
        s = re.split(r'_\d+minute', b)[0].upper()
        if s in LIQ: names[s] = i
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
    D = pd.DataFrame({'o': g.open.first(), 'h': g.high.max(), 'l': g.low.min(), 'c': g.close.last(), 'v': g.volume.sum(), 'n': g.size()})
    c1520 = b.close[tod == '15:15']; c1520.index = c1520.index.normalize(); D['p'] = c1520
    DAY[s] = D[D.n >= 60].dropna()
    if n % 100 == 0: log('loaded', n, round(time.time() - T0))
dates = sorted(set().union(*[set(d.index) for d in DAY.values()])); CUT = dates[int(len(dates) * 2 / 3)]
log('stocks', len(DAY), 'cut', CUT.date())

SLIP = 0.0005
BUY_COST = 0.001 + 0.00015 + 0.0000297 * 1.18 + SLIP          # STT, stamp, exch+GST, slippage
SELL_COST = 0.001 + 0.0000297 * 1.18 + SLIP + 15.34 / 1e5      # STT, exch+GST, slippage, DP on Rs 1L

def rsi(p, n):
    d = p.diff(); up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))
def supertrend(h, l, c, n=10, m=3):
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / n, adjust=False).mean(); mid = (h + l) / 2
    ub = (mid + m * atr).values; lb = (mid - m * atr).values; cc = c.values
    fu = ub.copy(); fl = lb.copy(); up = np.ones(len(cc), bool)
    for i in range(1, len(cc)):
        fu[i] = ub[i] if (ub[i] < fu[i - 1] or cc[i - 1] > fu[i - 1]) else fu[i - 1]
        fl[i] = lb[i] if (lb[i] > fl[i - 1] or cc[i - 1] < fl[i - 1]) else fl[i - 1]
        up[i] = True if cc[i] > fu[i - 1] else (False if cc[i] < fl[i - 1] else up[i - 1])
    return pd.Series(up, index=c.index)

def rules(D):
    p = D.p; h = D.h.shift(1); l = D.l.shift(1)   # use prior days' high/low (today's not complete at 15:20)
    ma20, ma50, ma100 = p.rolling(20).mean(), p.rolling(50).mean(), p.rolling(100).mean()
    r2, r14 = rsi(p, 2), rsi(p, 14)
    sd20 = p.rolling(20).std()
    e12, e26 = p.ewm(span=12).mean(), p.ewm(span=26).mean(); macd = e12 - e26; sig = macd.ewm(span=9).mean()
    hi20, lo10, hi55, lo20 = D.h.shift(1).rolling(20).max(), D.l.shift(1).rolling(10).min(), D.h.shift(1).rolling(55).max(), D.l.shift(1).rolling(20).min()
    vavg = D.v.shift(1).rolling(20).mean()
    st = supertrend(D.h.shift(1).bfill(), D.l.shift(1).bfill(), p)
    down3 = (p < p.shift(1)) & (p.shift(1) < p.shift(2)) & (p.shift(2) < p.shift(3))
    R = {}
    # (entry, exit, max_hold)
    R['RSI(2)<10 dip in uptrend, exit RSI(2)>70'] = ((r2 < 10) & (p > ma100), r2 > 70, 10)
    R['RSI(14)<30 oversold, exit RSI(14)>50'] = (r14 < 30, r14 > 50, 30)
    R['Bollinger lower band, exit at middle'] = (p < ma20 - 2 * sd20, p > ma20, 15)
    R['Bollinger lower band in uptrend'] = ((p < ma20 - 2 * sd20) & (p > ma100), p > ma20, 15)
    R['3 down days in uptrend, exit first up day'] = (down3 & (p > ma100), p > p.shift(1), 10)
    R['MA 20/50 crossover (hold while 20>50)'] = ((ma20 > ma50) & (ma20.shift(1) <= ma50.shift(1)), ma20 < ma50, 9999)
    R['Price above 100-day average (trend)'] = ((p > ma100) & (p.shift(1) <= ma100.shift(1)), p < ma100, 9999)
    R['MACD cross up, exit cross down'] = ((macd > sig) & (macd.shift(1) <= sig.shift(1)), macd < sig, 9999)
    R['Supertrend(10,3) buy, exit on flip'] = (st & ~st.shift(1, fill_value=True), ~st, 9999)
    R['20-day breakout, exit 10-day low'] = (p > hi20, p < lo10, 9999)
    R['55-day breakout, exit 20-day low'] = (p > hi55, p < lo20, 9999)
    R['Breakout on 2x volume, hold 10 days'] = ((p > hi20) & (D.v.shift(0) > 2 * vavg), pd.Series(False, index=p.index), 10)
    return R

POS = {}     # strategy -> list of (date, daily return) contributions
TRADES = {}
for s, D in DAY.items():
    if len(D) < 150: continue
    p = D.p.values; idx = D.index; ret = np.r_[0, p[1:] / p[:-1] - 1]
    for nm, (ent, ext, mh) in rules(D).items():
        ent = ent.fillna(False).values; ext = ext.fillna(False).values
        held = np.zeros(len(p)); start = -1; tr = TRADES.setdefault(nm, [])
        dr = np.full(len(p), np.nan)
        i = 100
        while i < len(p) - 1:
            if start < 0:
                if ent[i]: start = i; dr[i] = -BUY_COST
            else:
                dr[i] = ret[i]
                if ext[i] or i - start >= mh or i == len(p) - 2:
                    dr[i] += -SELL_COST
                    tr.append((idx[start], s, p[i] / p[start] * (1 - SELL_COST) / (1 + BUY_COST) - 1, i - start))
                    start = -1
            i += 1
        POS.setdefault(nm, []).append(pd.Series(dr, index=idx))
    if len(POS) and len(POS[next(iter(POS))]) % 100 == 0: log('rules', len(POS[next(iter(POS))]), round(time.time() - T0))

rows = []
def stats(dr, label, per, exposure, trades):
    if per == 'fit': dr = dr[dr.index < CUT]
    elif per == 'test': dr = dr[dr.index >= CUT]
    if len(dr) < 30: return
    eq = (1 + dr).cumprod(); yrs = len(dr) / 248
    tt = trades[trades.d < CUT] if per == 'fit' else trades[trades.d >= CUT] if per == 'test' else trades
    rows.append(dict(strategy=label, per=per, CAGR=(eq.iloc[-1] ** (1 / yrs) - 1) * 100, maxDD=(eq / eq.cummax() - 1).min() * 100,
                     invested_pct=exposure, trades=len(tt), avg_net_trade=tt.r.mean() * 100 if len(tt) else np.nan,
                     win=(tt.r > 0).mean() * 100 if len(tt) else np.nan, avg_days=tt.days.mean() if len(tt) else np.nan))
allp = pd.DataFrame({s: D.p for s, D in DAY.items()}).sort_index()
bh = allp.pct_change().mean(axis=1).fillna(0)
for per in ('fit', 'test', 'all'):
    stats(bh, 'Buy & hold all liquid (benchmark)', per, 100, pd.DataFrame(columns=['d', 'r', 'days']))
for nm, lst in POS.items():
    M = pd.concat(lst, axis=1)
    n_open = M.notna().sum(axis=1)
    dr = M.mean(axis=1).fillna(0)                 # equal weight across open positions; cash earns 0
    exposure = (n_open > 0).mean() * 100
    T = pd.DataFrame(TRADES[nm], columns=['d', 's', 'r', 'days'])
    for per in ('fit', 'test', 'all'): stats(dr, nm, per, round(exposure), T)
R = pd.DataFrame(rows).round(2); R.to_csv(f'{OUT}/ta_daily.csv', index=False)
P = R.pivot_table(index='strategy', columns='per', values=['CAGR', 'maxDD', 'avg_net_trade', 'win', 'trades']).round(2)
P = P.sort_values(('CAGR', 'test'), ascending=False)
rep = [f'# Round 4 — daily technical analysis, {len(DAY)} liquid stocks, {dates[0].date()} to {dates[-1].date()}',
       f'Fit < {CUT.date()} <= Test. Long only, delivery costs (STT both sides, stamp, DP, 0.05% slippage/side). Equal weight across open positions.\n',
       P.to_string()]
open(f'{OUT}/REPORT4.md', 'w').write('\n'.join(rep))
log('DONE', round(time.time() - T0))
