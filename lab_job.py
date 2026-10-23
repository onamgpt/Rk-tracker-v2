"""
BB Lab runner: takes the BB 5-min zip (any layout), runs the full research, writes summary tables.
usage: python lab_job.py <folder-with-unzipped-files> <out-folder>
"""
import os, sys, glob, re, io, pickle, time, traceback
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import aim_sim, band_sim, stats

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True); BARS = os.path.join(OUT, '_bars'); os.makedirs(BARS, exist_ok=True)
LOG = open(os.path.join(OUT, 'log.txt'), 'w')
def log(*a):
    s = ' '.join(str(x) for x in a); print(s, flush=True); LOG.write(s+'\n'); LOG.flush()

# ---------- 1. load any layout ----------
def find_col(cols, keys):
    for k in keys:
        for c in cols:
            if c.lower().replace(' ', '').replace('_', '') == k: return c
    for k in keys:
        for c in cols:
            if k in c.lower().replace(' ', '').replace('_', ''): return c
    return None
def read_any(p):
    pl = p.lower()
    if pl.endswith(('.xlsx', '.xls')): return pd.read_excel(p)
    if pl.endswith('.parquet'): return pd.read_parquet(p)
    if pl.endswith('.json'): return pd.read_json(p)
    return pd.read_csv(p, sep=None, engine='python') if os.path.getsize(p) < 2e6 else pd.read_csv(p)
import warnings; warnings.filterwarnings('ignore')
def smart_dt(x):
    best=None; score=-1
    for dayfirst in (False, True):
        t = pd.to_datetime(x, errors='coerce', dayfirst=dayfirst, format='mixed')
        ok = t.notna().mean(); mono = (t.diff().dt.total_seconds().dropna() > 0).mean() if t.notna().sum() > 2 else 0
        sc = ok + mono
        if sc > score: best, score = t, sc
    return best
def normalize(df, fname):
    cols = list(df.columns)
    o = find_col(cols, ['open']); h = find_col(cols, ['high']); l = find_col(cols, ['low'])
    c = find_col(cols, ['close', 'last', 'lastprice', 'ltp', 'price']); v = find_col(cols, ['volume', 'vol', 'qty'])
    ts = find_col(cols, ['timestamp', 'datetime', 'dateandtime', 'time', 'date'])
    dc = find_col(cols, ['date']); tc = find_col(cols, ['time'])
    if dc and tc and dc != tc:
        t = smart_dt(df[dc].astype(str)+' '+df[tc].astype(str))
    else:
        t = smart_dt(df[ts].astype(str).str[:19])
    sym = find_col(cols, ['symbol', 'ticker', 'tradingsymbol', 'scrip', 'name'])
    out = pd.DataFrame({'ts': t, 'open': pd.to_numeric(df[o], errors='coerce') if o else np.nan,
        'high': pd.to_numeric(df[h], errors='coerce') if h else np.nan,
        'low': pd.to_numeric(df[l], errors='coerce') if l else np.nan,
        'close': pd.to_numeric(df[c], errors='coerce'),
        'volume': pd.to_numeric(df[v], errors='coerce') if v else 0.0})
    for k in ['open', 'high', 'low']: out[k] = out[k].fillna(out['close'])
    out['sym'] = df[sym].astype(str).values if sym else re.split(r'[_\-. ]', os.path.basename(fname))[0].upper()
    return out.dropna(subset=['ts', 'close'])

import zipfile
def members():
    if SRC.lower().endswith('.zip'):
        z = zipfile.ZipFile(SRC)
        for i in z.infolist():
            n = i.filename
            if n.endswith('/') or os.path.basename(n).startswith('.') or not n.lower().endswith(('.csv', '.txt', '.xlsx', '.xls')): continue
            if os.path.basename(n).lower() == 'symbols.txt': continue
            yield n, (lambda i=i: z.open(i))
    else:
        for p in glob.glob(SRC+'/**/*', recursive=True):
            if os.path.isfile(p) and p.lower().endswith(('.csv', '.txt', '.xlsx', '.xls', '.parquet')):
                yield p, (lambda p=p: p)
meta = []; nfile = 0
for name, opener in members():
    nfile += 1
    try:
        src = opener()
        raw = pd.read_excel(src) if name.lower().endswith(('xlsx', 'xls')) else pd.read_csv(src)
        if nfile == 1: log('first file', name, 'columns', list(raw.columns)); log(raw.head(3).to_string())
        base = os.path.basename(name)
        sym = re.split(r'_\d+minute|_5min|_minute', base)[0].split('.')[0].upper()
        n = normalize(raw, name)
        if 'sym' in n and n['sym'].nunique() == 1: n['sym'] = sym
        for s, d in n.groupby('sym'):
            d = d.drop(columns='sym').drop_duplicates('ts').sort_values('ts').set_index('ts')
            if getattr(d.index, 'tz', None) is not None: d.index = d.index.tz_localize(None)
            step = d.index.to_series().diff().dt.total_seconds().median()
            if step < 300:
                d = d.resample('5min', label='left', closed='left').agg({'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum'}).dropna(subset=['close'])
            d = d.between_time('09:15', '15:25'); d = d[d.index.dayofweek < 5]
            days = pd.Series(d.index.date).nunique()
            if days < 120 or d.close.median() < 5: continue
            turnover = (d.close*d.volume).groupby(d.index.date).sum().median()
            d.to_pickle(f'{BARS}/{s}.pkl')
            meta.append(dict(sym=s, bars=len(d), days=days, start=d.index[0].date(), end=d.index[-1].date(), med_turnover_cr=round(turnover/1e7, 2), step_sec=step))
    except Exception as e:
        log('skip', name, repr(e)[:200])
    if nfile % 250 == 0: log('read', nfile, 'files', len(meta), 'usable')
log('files read:', nfile)
M = pd.DataFrame(meta).sort_values('med_turnover_cr', ascending=False); M.to_csv(f'{OUT}/universe.csv', index=False)
log('usable symbols:', len(M)); log(M.head(10).to_string())
LIQ = set(M[M.med_turnover_cr >= 20].sym)   # liquid: >= Rs 20 cr/day median turnover
log('liquid (>=20cr/day):', len(LIQ))

# ---------- 2. stylized facts + daily legs ----------
facts, legs = [], []
for s in M.sym:
    b = pd.read_pickle(f'{BARS}/{s}.pkl'); dd = b.index.date
    g = b.groupby(dd); O = g.open.first(); C = g.close.last()
    tod = b.index.strftime('%H:%M')
    c920 = b.close[tod == '09:15']; c920.index = c920.index.date
    c1520 = b.close[tod == '15:15']; c1520.index = c1520.index.date
    x = pd.DataFrame({'o': O, 'cl': C, 'c920': c920, 'c1520': c1520}).dropna()
    x['on'] = np.log(x.o/x.cl.shift(1)); x['intra'] = np.log(x.c1520/x.c920); x['s'] = s
    x['liq'] = s in LIQ
    legs.append(x.dropna())
    lc = np.log(b.close); r = lc.diff()[pd.Series(dd, index=b.index) == pd.Series(dd, index=b.index).shift(1)]
    cc = np.log(C).diff().dropna(); oc = np.log(C/O)
    facts.append(dict(sym=s, ann_vol=cc.std()*np.sqrt(248)*100, ac1_5m=r.autocorr(), ac1_daily=cc.autocorr(),
        VR_week=np.log(C).diff(5).var()/(5*cc.var()), overnight_ann=x.on.mean()*248*100, intraday_ann=x.intra.mean()*248*100,
        total_ann=cc.mean()*248*100))
F = pd.DataFrame(facts).round(3); F.to_csv(f'{OUT}/facts.csv', index=False)
L = pd.concat(legs); L['yr'] = pd.to_datetime(L.index).year
L.to_pickle(f'{OUT}/_legs.pkl')
rep = []
rep.append('## 1. Overnight vs intraday (equal-weight, % per day)\n')
for nm, sub in [('all', L), ('liquid', L[L.liq])]:
    p = sub.groupby(sub.index)[['on', 'intra']].mean()
    for c in ['on', 'intra']:
        x = p[c]; rep.append(f'- {nm} {c}: mean {x.mean()*100:.3f}%  t={x.mean()/x.std()*np.sqrt(len(x)):.2f}  days>0 {(x>0).mean()*100:.0f}%')
    rep.append('  by year: ' + ', '.join(f'{y}: on {v.on.mean()*100:.3f} / intra {v.intra.mean()*100:.3f}' for y, v in p.groupby(pd.to_datetime(p.index).year)))
rep.append('\nmedian facts:\n' + F.drop(columns='sym').median().round(3).to_string())

# ---------- 3. AIM family + Day-Night overlay ----------
CAP = 1_000_000.0
STRATS = [('AIM biweekly (current app)', 'bi', 0.10, 0.05, 0, 0, 0), ('AIM daily', 'd', 0.10, 0.05, 0, 0, 0),
          ('AIM 5-min safe5% rearm2%', '5', 0.05, 0.02, 0, 0, 0), ('AIM 5-min safe2% rearm1%', '5', 0.02, 0.01, 0, 0, 0),
          ('AIM 5-min safe1% rearm0.5%', '5', 0.01, 0.005, 0, 0, 0),
          ('DayNight AIM (full, gap>=0.5%)', 'bi', 0.10, 0.05, 1, 1.0, 0.005), ('DayNight AIM (full, gap>=0%)', 'bi', 0.10, 0.05, 1, 1.0, 0.0),
          ('DayNight AIM (half, gap>=0.5%)', 'bi', 0.10, 0.05, 1, 0.5, 0.005), ('DayNight AIM (full, every day)', 'bi', 0.10, 0.05, 1, 1.0, -1.0)]
res = []
universe = [s for s in M.sym if s in LIQ] or list(M.sym)
universe = universe[:150]
t0 = time.time()
for s in universe:
    b = pd.read_pickle(f'{BARS}/{s}.pkl'); c = b.close.values.astype(np.float64); o = b.open.values.astype(np.float64)
    d = pd.Series(b.index.date, index=b.index); dayid = pd.factorize(d)[0].astype(np.int64)
    k = b.groupby(dayid).cumcount().values.astype(np.int64); tod = b.index.strftime('%H:%M').values
    eod = tod == '15:15'; kin = 0; kout = int(np.median(k[tod == '15:20'])) if (tod == '15:20').any() else int(k.max()) - 1
    masks = {'5': np.ones(len(c), bool), 'd': eod, 'bi': eod & (dayid % 10 == 0)}
    dclose = b.close.groupby(dayid).last().values
    for sc in [0, 1, 2]:
        slip = 0.0 if sc == 0 else 0.0003
        p = c[0]*(1+slip)
        q = np.floor(CAP/p); res.append((s, 'Buy & hold 100%', sc)+stats(CAP-q*p+q*dclose, CAP)+(1,))
        q = np.floor(CAP*.5/p); res.append((s, 'Static 50/50', sc)+stats(CAP-q*p+q*dclose, CAP)+(1,))
        eq, n, tc = band_sim(c, dayid, 0.5, 0.05, CAP, sc, slip, False); res.append((s, 'Rebalance band 5%', sc)+stats(eq, CAP)+(n,))
        for nm, ck, sf, ra, em, ovf, ovg in STRATS:
            eq, n, tc, ovd, ovp = aim_sim(c, o, dayid, k, masks[ck], sf, 0.5, 5000.0, True, ra, CAP, sc, slip, em, ovf, ovg, kin, kout, 0.95)
            res.append((s, nm, sc)+stats(eq, CAP)+(n,))
    if len(res) % 300 < 40: log('aim', s, round(time.time()-t0))
R = pd.DataFrame(res, columns=['sym', 'strategy', 'costs', 'CAGR', 'vol', 'maxDD', 'ret_vol', 'trades']); R.to_csv(f'{OUT}/aim_results.csv', index=False)
T = R.pivot_table(index='strategy', columns='costs', values='CAGR', aggfunc='median').round(2)
T.columns = ['CAGR no costs', 'CAGR no brokerage', 'CAGR Zerodha'][:len(T.columns)]
T['median maxDD'] = R[R.costs == 2].groupby('strategy').maxDD.median().round(1)
T['mean CAGR Zerodha'] = R[R.costs == 2].groupby('strategy').CAGR.mean().round(2)
rep.append('\n## 2. AIM family (median across %d liquid stocks, Rs 10L each)\n' % len(universe))
rep.append(T.sort_values(T.columns[2], ascending=False).to_string())

# ---------- 4. Gap-Fade (intraday short top gappers 9:20 -> 15:20) ----------
def rt(V, sc, slip):
    if sc == 0: return 0.0
    brk = 0 if sc == 1 else 2*min(20, 0.0003*V)
    return (brk+0.00025*V+2*0.0000297*V+0.00003*V+0.18*(brk+2*0.0000297*V))/V+2*slip
G = L[L.liq].copy() if L.liq.any() else L.copy()
G['rank'] = G.groupby(G.index).on.rank(ascending=False)
alld = sorted(set(G.index)); cut = alld[int(len(alld)*2/3)]
fit = f'{alld[0]} to {cut}'; test = f'{cut} to {alld[-1]}'
rows = []
for K in [1, 3, 5, 10]:
    for g in [0.0, 0.005, 0.01, 0.02]:
        sel = G[(G['rank'] <= K) & (G.on >= g)]
        d = -sel.groupby(sel.index).intra.mean()
        for slip in [0.0003, 0.0005, 0.001]:
            for per in ['fit', 'test']:
                idx = pd.Index(d.index); m = (idx < cut) if per == 'fit' else (idx >= cut)
                x = d[m] - rt(1e5, 2, slip)
                if len(x) < 20: continue
                eq = (1+x).cumprod(); ny = len(x)/248*(248/max(1, len(x)))
                rows.append(dict(K=K, gap=g, slip_pct=slip*100, per=per, days=len(x), avg_net=x.mean()*100,
                                 t=x.mean()/x.std()*np.sqrt(len(x)), win=(x > 0).mean()*100, maxDD=(eq/eq.cummax()-1).min()*100))
GF = pd.DataFrame(rows).round(4); GF.to_csv(f'{OUT}/gapfade.csv', index=False)
rep.append(f'\n## 3. Gap-Fade, Zerodha intraday costs (fit years {fit}, test year {test})\n')
rep.append(GF.pivot_table(index=['slip_pct', 'K', 'gap'], columns='per', values=['avg_net', 't', 'days', 'maxDD']).round(3).to_string())
open(f'{OUT}/REPORT.md', 'w').write('\n'.join(rep))
log('DONE', round(time.time()-t0))
import shutil; shutil.rmtree(BARS, ignore_errors=True); os.remove(f'{OUT}/_legs.pkl')
