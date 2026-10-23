"""
Round 5: realistic portfolio simulation of the dip-buy strategies.
usage: python job5.py <symbols.zip> <universe.csv> <out>
- Capital = N slots x Rs 1L at start (compounds: each new trade uses equity/N).
- Max N open positions; when more signals than free slots, take the deepest dips first.
- Trades at the 15:20 price; delivery costs; idle cash earns 0 (also shown with 6% on idle cash).
"""
import sys, os, re, zipfile, time, warnings
import numpy as np, pandas as pd
warnings.filterwarnings('ignore')
ZIP, UNI, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
LOG = open(f'{OUT}/log5.txt', 'w')
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
P = {}; H = {}; L = {}
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
    cnt = g.size(); good = cnt[cnt >= 60].index
    c1520 = b.close[tod == '15:15']; c1520.index = c1520.index.normalize()
    P[s] = c1520.reindex(good)
    if n % 100 == 0: log('loaded', n, round(time.time() - T0))
PX = pd.DataFrame(P).sort_index()
dates = PX.index; CUT = dates[int(len(dates) * 2 / 3)]
log('stocks', PX.shape[1], 'days', len(dates))

SLIP = 0.0005
BUY = 0.001 + 0.00015 + 0.0000297 * 1.18 + SLIP
SELL = 0.001 + 0.0000297 * 1.18 + SLIP
DP = 15.34

def monthly(e):
    try: return e.resample('ME').last()
    except Exception: return e.resample('M').last()
def rsi(p, n):
    d = p.diff(); up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))
ma20 = PX.rolling(20, min_periods=20).mean(); sd20 = PX.rolling(20, min_periods=20).std(); ma100 = PX.rolling(100, min_periods=100).mean()
R2 = PX.apply(lambda c: rsi(c.dropna(), 2).reindex(c.index))
z20 = (PX - ma20) / sd20
STRATS = {
    'RSI(2)<10 in uptrend': dict(entry=(R2 < 10) & (PX > ma100), exit=R2 > 70, prio=R2, maxhold=10),
    'Bollinger lower band in uptrend': dict(entry=(PX < ma20 - 2 * sd20) & (PX > ma100), exit=PX > ma20, prio=z20, maxhold=15),
}
pxv = PX.values; cols = list(PX.columns)
rows = []; curves = {}
for nm, S in STRATS.items():
    ent = S['entry'].fillna(False).values; ext = S['exit'].fillna(False).values; pri = S['prio'].values
    for N in (5, 10, 20):
        for idle_rate in (0.0, 0.06):
            cash = N * 1e5; pos = {}   # col -> [shares, entry_px, entry_day]
            eq = np.zeros(len(dates)); trades = []
            for i in range(len(dates)):
                if idle_rate: cash *= (1 + idle_rate / 248)
                # exits
                for j in list(pos):
                    px = pxv[i, j]
                    if np.isnan(px): continue
                    sh, ep, ed = pos[j]
                    if ext[i, j] or i - ed >= S['maxhold'] or i == len(dates) - 1:
                        v = sh * px * (1 - SELL) - DP; cash += v
                        trades.append((dates[ed], v / (sh * ep * (1 + BUY)) - 1, i - ed)); del pos[j]
                # entries
                free = N - len(pos)
                if free > 0 and i < len(dates) - 1:
                    cand = [j for j in np.where(ent[i])[0] if j not in pos and not np.isnan(pxv[i, j])]
                    cand.sort(key=lambda j: pri[i, j])
                    equity = cash + sum(sh * (pxv[i, j] if not np.isnan(pxv[i, j]) else ep) for j, (sh, ep, ed) in pos.items())
                    size = equity / N
                    for j in cand[:free]:
                        px = pxv[i, j]; sh = np.floor(min(size, cash) / (px * (1 + BUY)))
                        if sh <= 0: break
                        cash -= sh * px * (1 + BUY); pos[j] = [sh, px, i]
                eq[i] = cash + sum(sh * (pxv[i, j] if not np.isnan(pxv[i, j]) else ep) for j, (sh, ep, ed) in pos.items())
            E = pd.Series(eq, index=dates); T = pd.DataFrame(trades, columns=['d', 'r', 'days'])
            curves[f'{nm} | {N} slots | idle {int(idle_rate*100)}%'] = E
            for per in ('all', 'fit', 'test'):
                e = E if per == 'all' else (E[E.index < CUT] if per == 'fit' else E[E.index >= CUT])
                tt = T if per == 'all' else (T[T.d < CUT] if per == 'fit' else T[T.d >= CUT])
                yrs = len(e) / 248
                m = monthly(e).pct_change().dropna()
                rows.append(dict(strategy=nm, slots=N, start_capital_L=N, idle_cash_pct=int(idle_rate * 100), per=per,
                                 CAGR=((e.iloc[-1] / e.iloc[0]) ** (1 / yrs) - 1) * 100, maxDD=(e / e.cummax() - 1).min() * 100,
                                 worst_month=m.min() * 100, trades=len(tt), net_per_trade=tt.r.mean() * 100, win=(tt.r > 0).mean() * 100,
                                 avg_days=tt.days.mean()))
            log(nm, N, idle_rate, round(time.time() - T0))
bh = PX.pct_change().mean(axis=1).fillna(0); BH = (1 + bh).cumprod()
for per in ('all', 'fit', 'test'):
    e = BH if per == 'all' else (BH[BH.index < CUT] if per == 'fit' else BH[BH.index >= CUT]); yrs = len(e) / 248
    rows.append(dict(strategy='Buy & hold all liquid', slots=0, per=per, CAGR=((e.iloc[-1] / e.iloc[0]) ** (1 / yrs) - 1) * 100,
                     maxDD=(e / e.cummax() - 1).min() * 100, worst_month=monthly(e).pct_change().min() * 100))
Rr = pd.DataFrame(rows).round(2); Rr.to_csv(f'{OUT}/dipbuy_portfolio.csv', index=False)
pd.DataFrame(curves).to_csv(f'{OUT}/dipbuy_equity_curves.csv')
Pv = Rr.pivot_table(index=['strategy', 'slots', 'idle_cash_pct'], columns='per', values=['CAGR', 'maxDD', 'worst_month', 'net_per_trade', 'win', 'trades']).round(2)
rep = [f'# Round 5 — Dip-buy portfolio, realistic sizing. {PX.shape[1]} liquid stocks, {dates[0].date()} to {dates[-1].date()}. Fit < {CUT.date()} <= Test',
       'Start capital = slots x Rs 1L, each trade = equity/slots, deepest dip first, delivery costs + 0.05% slippage/side.\n', Pv.to_string()]
open(f'{OUT}/REPORT5.md', 'w').write('\n'.join(rep))
log('DONE', round(time.time() - T0))
