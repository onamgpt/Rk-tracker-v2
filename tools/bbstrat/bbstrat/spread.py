"""
The "gate" strategy — earning the bid/ask spread.

  analyze_gates(quotes, ...)   how wide the gate is, how often it is wider than
                               costs, how long wide gates last, how long the best
                               bid / offer stay unchanged, how often trades print.

  simulate_quoting(quotes, ...) a simple passive two-sided quoting simulation:
                               sit at (or one tick inside) the best bid and offer
                               while the gate is wide, take the round trip when
                               both sides fill, cut losses after N ticks against,
                               flatten at day end — with any CostModel.

IMPORTANT — fills are estimated. Real queue position is unknown from top-of-book
data, so two assumptions are offered:
  queue="front"  you are first at your price: a trade AT your price fills you
                 (optimistic — what a very fast terminal might achieve)
  queue="back"   you fill only when the market trades THROUGH your price
                 (pessimistic)
The truth for the BB terminal lies in between; compare both.
"""
from dataclasses import dataclass, asdict
import numpy as np
import pandas as pd

from .costs import CostModel, zerodha


def analyze_gates(quotes: pd.DataFrame, costs: CostModel = None, trade_value: float = 100_000,
                  wide_multiple: float = 2.0, tick: float = 0.05) -> dict:
    costs = costs or zerodha("intraday")
    q = quotes
    cost_pct = costs.round_trip_pct(trade_value)
    wide_at = cost_pct * wide_multiple
    mid = (q["bid"] + q["ask"]) / 2
    pct = (q["ask"] - q["bid"]) / mid * 100
    wide = (pct >= wide_at).values
    t = q["ts"].values.astype("datetime64[ms]").astype("int64") / 1000.0

    def runs(flag):
        out, start = [], None
        for i, f in enumerate(flag):
            if f and start is None:
                start = t[i]
            elif not f and start is not None:
                out.append(t[i] - start)
                start = None
        if start is not None:
            out.append(t[-1] - start)
        return np.array(out)

    def lifetimes(series):
        v = series.values
        ch = np.r_[True, v[1:] != v[:-1]]
        idx = np.flatnonzero(ch)
        return np.diff(np.r_[t[idx], t[-1]])

    ep = runs(wide)
    span = max(1.0, t[-1] - t[0])
    vol = q["volume"].fillna(0).values
    trades = int(np.sum(np.diff(vol) > 0))
    bid_life, ask_life = lifetimes(q["bid"]), lifetimes(q["ask"])

    def stats(a):
        if not len(a):
            return {"median": 0, "p90": 0, "max": 0}
        return {"median": round(float(np.median(a)), 1), "p90": round(float(np.percentile(a, 90)), 1), "max": round(float(a.max()), 1)}

    return {
        "round_trip_cost_pct": round(cost_pct, 4),
        "wide_threshold_pct": round(wide_at, 4),
        "avg_gate_pct": round(float(pct.mean()), 4),
        "avg_gate_ticks": round(float(((q["ask"] - q["bid"]) / tick).mean()), 2),
        "pct_time_wide": round(float(ep.sum() / span * 100), 2),
        "wide_spells": int(len(ep)),
        "wide_spell_seconds": stats(ep),
        "best_bid_unchanged_seconds": stats(bid_life),
        "best_offer_unchanged_seconds": stats(ask_life),
        "trades_per_minute": round(trades / (span / 60), 2),
        "observed_seconds": round(span, 0),
    }


@dataclass
class QuoteParams:
    qty: int = 100                 # shares per order
    improve_ticks: int = 0         # 0 = join best bid/offer, 1 = step one tick inside
    min_gate_multiple: float = 2.0 # only quote when gate >= this x round-trip cost
    trade_value_for_cost: float = 100_000
    stop_ticks: int = 4            # exit at market if price moves this many ticks against
    max_hold_seconds: int = 1200   # exit at market if held longer than this (20 min)
    allow_short: bool = True       # intraday short (sell first, buy back)
    queue: str = "front"           # "front" (optimistic) or "back" (pessimistic)
    tick: float = 0.05
    flatten_at: str = "15:20"      # close any position at/after this time


def simulate_quoting(quotes: pd.DataFrame, costs: CostModel = None, params: QuoteParams = None) -> dict:
    p = params or QuoteParams()
    costs = costs or zerodha("intraday")
    cost_pct = costs.round_trip_pct(p.trade_value_for_cost)
    q = quotes.reset_index(drop=True)
    bid, ask, last, vol = q["bid"].values, q["ask"].values, q["last"].values, q["volume"].fillna(0).values
    ts = pd.to_datetime(q["ts"])
    hhmm = ts.dt.strftime("%H:%M").values
    day = ts.dt.date.values
    pos, entry, entry_t = 0, 0.0, None
    buy_px = sell_px = None
    trades, modifications = [], 0
    fh, fm = map(int, p.flatten_at.split(":"))

    def fill(i, side, qty, px, reason):
        nonlocal pos, entry, entry_t
        value = qty * px
        c = costs.order_cost(side, value)
        trades.append({"ts": ts.iloc[i], "side": side, "qty": qty, "price": round(px, 4), "cost": round(c, 2),
                       "reason": reason, "pos_after": pos + (qty if side == "buy" else -qty)})
        if pos == 0:
            entry, entry_t = px, ts.iloc[i]
        pos += qty if side == "buy" else -qty

    for i in range(1, len(q)):
        traded = vol[i] > vol[i - 1]
        # 1) did our resting orders fill on this update?
        if buy_px is not None:
            hit = (traded and (last[i] <= buy_px if p.queue == "front" else last[i] < buy_px)) or ask[i] <= buy_px
            if hit:
                fill(i, "buy", p.qty, buy_px, "passive bid")
                buy_px = None
        if sell_px is not None:
            hit = (traded and (last[i] >= sell_px if p.queue == "front" else last[i] > sell_px)) or bid[i] >= sell_px
            if hit:
                fill(i, "sell", p.qty, sell_px, "passive offer")
                sell_px = None
        # 2) risk exits (pay the spread)
        end_of_day = (i == len(q) - 1) or (day[i] != day[i + 1]) or (int(hhmm[i][:2]) * 60 + int(hhmm[i][3:]) >= fh * 60 + fm)
        if pos != 0:
            held = (ts.iloc[i] - entry_t).total_seconds() if entry_t is not None else 0
            against = (entry - bid[i]) / p.tick if pos > 0 else (ask[i] - entry) / p.tick
            reason = "day end" if end_of_day else "stop" if against >= p.stop_ticks else "time stop" if held >= p.max_hold_seconds else None
            if reason:
                if pos > 0:
                    fill(i, "sell", pos, bid[i], reason)
                else:
                    fill(i, "buy", -pos, ask[i], reason)
                buy_px = sell_px = None
                continue
        if end_of_day:
            buy_px = sell_px = None
            continue
        # 3) where should our quotes sit now?
        mid = (bid[i] + ask[i]) / 2
        gate_pct = (ask[i] - bid[i]) / mid * 100
        wide = gate_pct >= cost_pct * p.min_gate_multiple
        nb = round(bid[i] + p.improve_ticks * p.tick, 4)
        na = round(ask[i] - p.improve_ticks * p.tick, 4)
        if na <= nb:
            nb, na = bid[i], ask[i]
        want_buy = (pos < 0) or (pos == 0 and wide)
        want_sell = (pos > 0) or (pos == 0 and wide and p.allow_short)
        if pos > 0:      # long: only offer, never below entry + 1 tick unless stopping out
            na = max(na, entry + p.tick)
        if pos < 0:      # short: only bid, never above entry - 1 tick
            nb = min(nb, entry - p.tick)
        new_b = nb if want_buy else None
        new_s = na if want_sell else None
        if new_b != buy_px:
            modifications += 1
        if new_s != sell_px:
            modifications += 1
        buy_px, sell_px = new_b, new_s

    tr = pd.DataFrame(trades)
    if not len(tr):
        return {"trades": tr, "summary": {"round_trips": 0, "net_pnl": 0.0, "note": "no fills"}}
    signed = np.where(tr["side"] == "sell", 1, -1) * tr["qty"] * tr["price"]
    gross = float(signed.sum())
    cost = float(tr["cost"].sum())
    # round trips: a position returning to zero
    flat_idx = tr.index[tr["pos_after"] == 0]
    rts, prev = [], 0
    for k in flat_idx:
        seg = tr.loc[prev:k]
        g = float((np.where(seg["side"] == "sell", 1, -1) * seg["qty"] * seg["price"]).sum())
        rts.append({"gross": g, "cost": float(seg["cost"].sum()), "secs": (seg["ts"].iloc[-1] - seg["ts"].iloc[0]).total_seconds(),
                    "exit": seg["reason"].iloc[-1]})
        prev = k + 1
    rt = pd.DataFrame(rts)
    net_each = rt["gross"] - rt["cost"] if len(rt) else pd.Series(dtype=float)
    summary = {
        "costs_model": costs.name, "queue_assumption": p.queue,
        "round_trips": int(len(rt)),
        "gross_pnl": round(gross, 2), "costs": round(cost, 2), "net_pnl": round(gross - cost, 2),
        "win_rate_pct": round(float((net_each > 0).mean() * 100), 1) if len(rt) else 0,
        "avg_net_per_round_trip": round(float(net_each.mean()), 2) if len(rt) else 0,
        "median_hold_seconds": round(float(rt["secs"].median()), 1) if len(rt) else 0,
        "exits": rt["exit"].value_counts().to_dict() if len(rt) else {},
        "order_modifications": int(modifications),
        "order_to_trade_ratio": round(modifications / max(1, len(tr)), 1),
    }
    return {"trades": tr, "round_trips": rt, "summary": summary}


def compare_quoting_costs(quotes, models, params: QuoteParams = None) -> pd.DataFrame:
    """Same quoting run under several cost models (with / without brokerage etc.)."""
    rows = []
    for m in models:
        for qmode in ("front", "back"):
            pr = QuoteParams(**{**asdict(params or QuoteParams()), "queue": qmode})
            rows.append(simulate_quoting(quotes, m, pr)["summary"])
    return pd.DataFrame(rows)
