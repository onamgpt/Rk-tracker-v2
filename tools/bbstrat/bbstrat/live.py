"""
Hooks for running the strategies live on the BB terminal.

The terminal stays in charge of orders. These classes only:
  - build 1-minute bars from ticks           (BarBuilder)
  - keep running gate statistics per symbol  (GateMonitor)
  - say what AIM would do now, and update
    their state from the terminal's REAL fills (LiveAIM)

Typical wiring inside the terminal's tick handler:

    bars = BarBuilder(on_bar=lambda sym, bar: aim[sym].on_bar(bar))
    gates = GateMonitor(cost_pct=zerodha().round_trip_pct(100_000))

    def on_tick(sym, ts, last, volume, bid, ask):
        bars.on_tick(sym, ts, last, volume)
        gates.on_quote(sym, ts, bid, ask, volume)

    # when the terminal confirms an execution:
    aim[sym].confirm_fill(side, shares, price, cost)
"""
from collections import defaultdict
import numpy as np
import pandas as pd

from .aim import AIMAccount, AIMParams
from .costs import CostModel, no_costs


class BarBuilder:
    def __init__(self, on_bar=None, minutes: int = 1):
        self.on_bar = on_bar
        self.freq = "%dmin" % minutes
        self.cur = {}

    def on_tick(self, symbol, ts, price, cum_volume=None):
        ts = pd.Timestamp(ts)
        key = ts.floor(self.freq)
        b = self.cur.get(symbol)
        if b and b["ts"] != key:
            if self.on_bar:
                self.on_bar(symbol, b)
            b = None
        if not b:
            b = {"ts": key, "open": price, "high": price, "low": price, "close": price, "volume": 0, "_v0": cum_volume}
            self.cur[symbol] = b
        b["high"] = max(b["high"], price)
        b["low"] = min(b["low"], price)
        b["close"] = price
        if cum_volume is not None and b["_v0"] is not None:
            b["volume"] = cum_volume - b["_v0"]


class GateMonitor:
    """Running statistics of the gate per symbol, updated on every quote."""

    def __init__(self, cost_pct: float, wide_multiple: float = 2.0):
        self.wide_at = cost_pct * wide_multiple
        self.s = defaultdict(lambda: {"wide_since": None, "wide_spells": [], "bid": None, "bid_since": None, "bid_life": [],
                                      "ask": None, "ask_since": None, "ask_life": [], "first": None, "last": None,
                                      "wide_secs": 0.0, "vol": None, "trades": 0, "gate_pct": None})

    def on_quote(self, symbol, ts, bid, ask, cum_volume=None):
        if not bid or not ask or ask <= bid:
            return
        t = pd.Timestamp(ts).timestamp()
        x = self.s[symbol]
        x["first"] = x["first"] or t
        x["last"] = t
        pct = (ask - bid) / ((ask + bid) / 2) * 100
        x["gate_pct"] = pct
        if bid != x["bid"]:
            if x["bid_since"]:
                x["bid_life"].append(t - x["bid_since"])
            x["bid"], x["bid_since"] = bid, t
        if ask != x["ask"]:
            if x["ask_since"]:
                x["ask_life"].append(t - x["ask_since"])
            x["ask"], x["ask_since"] = ask, t
        if cum_volume is not None:
            if x["vol"] is not None and cum_volume > x["vol"]:
                x["trades"] += 1
            x["vol"] = cum_volume
        if pct >= self.wide_at and x["wide_since"] is None:
            x["wide_since"] = t
        elif pct < self.wide_at and x["wide_since"] is not None:
            d = t - x["wide_since"]
            x["wide_spells"].append(d)
            x["wide_secs"] += d
            x["wide_since"] = None

    def snapshot(self) -> pd.DataFrame:
        rows = []
        for sym, x in self.s.items():
            span = max(1.0, (x["last"] or 0) - (x["first"] or 0))
            open_wide = (x["last"] - x["wide_since"]) if x["wide_since"] else 0
            sp = x["wide_spells"] + ([open_wide] if open_wide else [])
            rows.append({"symbol": sym, "gate_pct_now": round(x["gate_pct"] or 0, 4), "wide_now": x["wide_since"] is not None,
                         "pct_time_wide": round((x["wide_secs"] + open_wide) / span * 100, 2), "wide_spells": len(sp),
                         "wide_median_s": round(float(np.median(sp)), 1) if sp else 0,
                         "wide_max_s": round(float(max(sp)), 1) if sp else 0,
                         "bid_life_median_s": round(float(np.median(x["bid_life"])), 1) if x["bid_life"] else 0,
                         "ask_life_median_s": round(float(np.median(x["ask_life"])), 1) if x["ask_life"] else 0,
                         "trades_per_min": round(x["trades"] / (span / 60), 2)})
        return pd.DataFrame(rows).sort_values("pct_time_wide", ascending=False) if rows else pd.DataFrame()


class LiveAIM:
    """AIM that SUGGESTS orders and learns from the terminal's real executions."""

    def __init__(self, capital: float, params: AIMParams = None, costs: CostModel = None, name="AIM"):
        self.acc = AIMAccount(capital, params, costs or no_costs(), name)
        self.acc.p.execution = "close"

    def initial_order(self, price):
        """The first order to place (buys the starting stock share)."""
        return ("buy", int(self.acc.capital * self.acc.p.start_stock_frac // price))

    def on_bar(self, bar):
        """Call on each completed bar; returns ('buy'|'sell', shares) or None."""
        if not self.acc.started:
            return self.initial_order(bar["close"])
        d = self.acc._decide(float(bar["close"]))
        return d if d and d[1] > 0 else None

    def confirm_fill(self, side, shares, price, cost=None, ts=None):
        """Tell the model what really executed (price, shares, actual charges)."""
        a = self.acc
        value = shares * price
        cost = a.costs.order_cost(side, value) if cost is None else cost
        if side == "buy":
            a.cash -= value + cost
            a.shares += shares
            if not a.started:
                a.pc = a.shares * price
                a.started = True
            elif a.p.mode == "aim":
                a.pc += value * a.p.pc_increment
        else:
            a.cash += value - cost
            a.shares -= shares
        a.total_costs += cost
        a.last_trade_price = price
        a.trades.append({"ts": ts or pd.Timestamp.now(), "side": side, "shares": shares, "price": price, "cost": cost, "reason": "live"})
