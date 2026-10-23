import numpy as np, pandas as pd
from numba import njit

# cost scenario codes: 0 none, 1 no-brokerage (statutory only), 2 zerodha
@njit(cache=True)
def cost(side_buy, value, intraday, sc):
    if sc == 0 or value <= 0: return 0.0
    brk = 0.0
    if sc == 2 and intraday: brk = min(20.0, 0.0003*value)
    exch = 0.0000297*value; sebi = 0.000001*value
    gst = 0.18*(brk+exch+sebi)
    if intraday:
        stt = 0.0 if side_buy else 0.00025*value
        stamp = 0.00003*value if side_buy else 0.0
        dp = 0.0
    else:
        stt = 0.001*value
        stamp = 0.00015*value if side_buy else 0.0
        dp = 0.0 if side_buy else (15.34 if sc == 2 else 13.0)
    return brk+stt+exch+sebi+stamp+gst+dp

@njit(cache=True)
def aim_sim(c, o, dayid, k, check, safe, pc_inc, min_trade, block_below_avg, rearm, cap, sc, slip,
            exec_mode, ov_frac, ov_gap, ov_k_in, ov_k_out, max_frac):
    """
    AIM on bars. check[i]=True where AIM evaluates (at bar close).
    exec_mode 0: fill AIM trade at same bar close; 1: buys at close, sells deferred to next ov_k_in bar (morning)
    ov_frac>0: Day-Night overlay: at bar k==ov_k_in sell ov_frac of holdings (if today's gap>=ov_gap), buy back at k==ov_k_out.
    Returns daily equity, n_trades, total_cost, n_overlay_days, overlay_pnl
    """
    n = len(c); cash = cap; sh = 0.0; pc = 0.0; avg = 0.0; tcost = 0.0; ntr = 0
    last_buy = 1e18; last_sell = 0.0
    nd = dayid[-1]+1
    eq = np.zeros(nd)
    pend_sell = 0.0
    ov_sh = 0.0; ov_px = 0.0; ovd = 0; ovpnl = 0.0
    prev_close = c[0]; gap = 0.0
    started = False
    for i in range(n):
        if not started:
            px = c[i]*(1+slip); q = np.floor(cap*0.5/px)
            v = q*px; f = cost(True, v, False, sc)
            cash -= v+f; sh = q; avg = px; pc = q*c[i]; tcost += f; ntr += 1; started = True
            continue
        if k[i] == 0:
            gap = o[i]/prev_close - 1.0
        # morning: deferred AIM sells
        if k[i] == ov_k_in and pend_sell > 0:
            q = min(pend_sell, sh); px = c[i]*(1-slip); v = q*px
            if q > 0:
                f = cost(False, v, False, sc); cash += v-f; sh -= q; tcost += f; ntr += 1; last_sell = px
            pend_sell = 0.0
        # overlay out (sell part of holdings intraday)
        if ov_frac > 0 and k[i] == ov_k_in and gap >= ov_gap and sh > 0:
            q = np.floor(sh*ov_frac)
            if q > 0:
                px = c[i]*(1-slip); v = q*px; f = cost(False, v, True, sc)
                cash += v-f; sh -= q; tcost += f; ov_sh = q; ov_px = px; ovd += 1; ovpnl -= f
        if ov_sh > 0 and k[i] == ov_k_out:
            px = c[i]*(1+slip); v = ov_sh*px; f = cost(True, v, True, sc)
            cash -= v+f; sh += ov_sh; tcost += f; ovpnl += (ov_px-px)*ov_sh - f; ov_sh = 0.0
        if check[i]:
            hold = sh + ov_sh
            val = hold*c[i]; equity = cash - ov_sh*c[i] + val  # cash includes short proceeds
            adv = pc - val; sf = safe*val
            if adv > sf:
                amt = adv - sf
                room = max_frac*equity - val
                if amt > room: amt = room
                if amt > cash - ov_sh*c[i]: amt = cash - ov_sh*c[i]
                if amt >= min_trade and c[i] <= last_buy*(1-rearm):
                    px = c[i]*(1+slip); q = np.floor(amt/px)
                    if q > 0:
                        v = q*px; f = cost(True, v, False, sc)
                        cash -= v+f; avg = (avg*hold + v)/(hold+q); sh += q; pc += pc_inc*v; tcost += f; ntr += 1
                        last_buy = px; last_sell = 0.0
            elif -adv > sf:
                amt = -adv - sf
                okp = (not block_below_avg) or c[i] > avg
                if amt >= min_trade and okp and c[i] >= last_sell*(1+rearm):
                    q = np.floor(amt/c[i])
                    if exec_mode == 1:
                        pend_sell = q; last_sell = c[i]; last_buy = 1e18
                    else:
                        q = min(q, sh)
                        if q > 0:
                            px = c[i]*(1-slip); v = q*px; f = cost(False, v, False, sc)
                            cash += v-f; sh -= q; tcost += f; ntr += 1; last_sell = px; last_buy = 1e18
        if i == n-1 or dayid[i+1] != dayid[i]:
            if ov_sh > 0:   # safety: buy back at day end
                px = c[i]*(1+slip); v = ov_sh*px; f = cost(True, v, True, sc)
                cash -= v+f; sh += ov_sh; tcost += f; ovpnl += (ov_px-px)*ov_sh - f; ov_sh = 0.0
            eq[dayid[i]] = cash + sh*c[i]
            prev_close = c[i]
    return eq, ntr, tcost, ovd, ovpnl

@njit(cache=True)
def band_sim(c, dayid, target, band, cap, sc, slip, intraday_reset):
    """Constant-mix rebalancing: keep stock weight at target; trade back to target when weight drifts by > band (abs)."""
    n=len(c); px=c[0]*(1+slip); sh=np.floor(cap*target/px); f=cost(True,sh*px,False,sc); cash=cap-sh*px-f
    tc=f; ntr=1; eq=np.zeros(dayid[-1]+1)
    for i in range(1,n):
        val=sh*c[i]; E=cash+val; w=val/E
        if abs(w-target) > band:
            dv=target*E-val
            if dv>0:
                p=c[i]*(1+slip); q=np.floor(dv/p); v=q*p; f=cost(True,v,False,sc); cash-=v+f; sh+=q
            else:
                p=c[i]*(1-slip); q=min(np.floor(-dv/p),sh); v=q*p; f=cost(False,v,False,sc); cash+=v-f; sh-=q
            tc+=f; ntr+=1
        if i==n-1 or dayid[i+1]!=dayid[i]: eq[dayid[i]]=cash+sh*c[i]
    return eq, ntr, tc

def load(path):
    b = pd.read_pickle(path)
    d = pd.Series(b.index.date, index=b.index)
    dayid = pd.factorize(d)[0].astype(np.int64)
    k = (d != d.shift(1)).astype(int).groupby(dayid).cumsum().values  # placeholder
    k = b.groupby(dayid).cumcount().values.astype(np.int64)
    tod = b.index.strftime('%H:%M').values
    return b, dayid, k, tod

def stats(eq, cap):
    eq = np.asarray(eq); eq = eq[eq > 0]
    yrs = len(eq)/248.0
    cagr = (eq[-1]/cap)**(1/yrs)-1
    r = np.diff(np.log(eq)); vol = r.std()*np.sqrt(248)
    dd = (eq/np.maximum.accumulate(eq)-1).min()
    return cagr*100, vol*100, dd*100, (cagr/vol if vol>0 else 0)
