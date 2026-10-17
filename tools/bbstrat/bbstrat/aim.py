"""
AIM (Lichello's Automatic Investment Management) for short time frames,
plus "staggered AIM" — several AIM accounts on the same stock, started at
different times (e.g. a new tranche of ACC every week).

Two decision modes:
  mode="aim"   classic AIM: Portfolio Control (PC) vs stock value, with SAFE.
               Buy  = (PC - value) - SAFE   when the stock has fallen
               Sell = (value - PC) - SAFE   when it has risen
               PC rises by `pc_increment` x each buy (Lichello used 0.5).
  mode="grid"  simpler: buy `grid_value` rupees when price is `grid_pct` below
               the last trade price, sell the same when it is `grid_pct` above.

Session:
  carry=True   positions are held overnight (use delivery costs)
  carry=False  pure intraday: everything is sold at the day's last bar and the
               account restarts next morning (use intraday costs)

The same classes work in a backtest (run on a DataFrame of bars) and live
(call .step(ts, price) on every new bar from the BB terminal).
"""
from dataclasses import dataclass, field, asdict
import math
import pandas as pd

from .costs import CostModel, no_costs


@dataclass
class AIMParams:
    mode: str = "aim"              # "aim" or "grid"
    start_stock_frac: float = 0.5  # share of capital put into the stock at the start
    safe_pct: float = 0.10         # AIM SAFE as a fraction of stock value (smaller = more trades)
    pc_increment: float = 0.5      # AIM: PC grows by this x each buy
    min_trade_value: float = 2000  # skip orders smaller than this (rupees)
    max_stock_frac: float = 0.95   # never hold more than this share of equity in stock
    grid_pct: float = 0.01         # grid mode trigger (1%)
    grid_value: float = 10000      # grid mode order size (rupees)
    check_every: int = 1           # evaluate every N bars (1 = every minute)
    carry: bool = True             # hold overnight? False = flat at day end
    execution: str = "next_open"   # "close" or "next_open" (more realistic)
    slippage_pct: float = 0.0      # extra price penalty per fill, e.g. 0.0002 = 0.02%


class AIMAccount:
    def __init__(self, capital: float, params: AIMParams = None, costs: CostModel = None, name: str = "AIM"):
        self.p = params or AIMParams()
        self.costs = costs or no_costs()
        self.name = name
        self.capital = float(capital)
        self.cash = float(capital)
        self.shares = 0
        self.pc = 0.0
        self.last_trade_price = None
        self.started = False
        self.trades = []
        self.total_costs = 0.0
        self._bar = 0
        self._pending = None   # order decided on a close, filled on next open

    # -- helpers --
    def equity(self, price: float) -> float:
        return self.cash + self.shares * price

    def _fill(self, ts, side, shares, price, reason):
        if shares <= 0:
            return None
        px = price * (1 + self.p.slippage_pct) if side == "buy" else price * (1 - self.p.slippage_pct)
        value = shares * px
        cost = self.costs.order_cost(side, value)
        if side == "buy":
            if value + cost > self.cash:
                shares = int((self.cash - cost) // px)
                if shares <= 0:
                    return None
                value = shares * px
                cost = self.costs.order_cost(side, value)
            self.cash -= value + cost
            self.shares += shares
        else:
            shares = min(shares, self.shares)
            if shares <= 0:
                return None
            value = shares * px
            cost = self.costs.order_cost(side, value)
            self.cash += value - cost
            self.shares -= shares
        self.total_costs += cost
        self.last_trade_price = px
        t = {"ts": ts, "account": self.name, "side": side, "shares": int(shares), "price": round(px, 4),
             "value": round(value, 2), "cost": round(cost, 2), "reason": reason,
             "cash": round(self.cash, 2), "pos": int(self.shares), "pc": round(self.pc, 2)}
        self.trades.append(t)
        return t

    def _start(self, ts, price):
        buy_val = self.capital * self.p.start_stock_frac
        sh = int(buy_val // price)
        self._fill(ts, "buy", sh, price, "start")
        self.pc = self.shares * price
        self.started = True

    def _decide(self, price):
        """Return (side, shares) or None — based on the bar's close."""
        p = self.p
        value = self.shares * price
        eq = self.equity(price)
        if p.mode == "grid":
            ref = self.last_trade_price or price
            if price <= ref * (1 - p.grid_pct):
                if (value + p.grid_value) / max(eq, 1) > p.max_stock_frac:
                    return None
                return ("buy", int(p.grid_value // price))
            if price >= ref * (1 + p.grid_pct) and self.shares > 0:
                return ("sell", int(min(self.shares, p.grid_value // price)))
            return None
        safe = p.safe_pct * value
        advice = self.pc - value
        if advice > 0:
            amt = advice - safe
            amt = min(amt, self.cash, max(0.0, p.max_stock_frac * eq - value))
            if amt >= p.min_trade_value:
                return ("buy", int(amt // price))
        elif advice < 0:
            amt = -advice - safe
            if amt >= p.min_trade_value:
                return ("sell", int(min(self.shares, amt // price)))
        return None

    # -- the one call used both in backtests and live --
    def step(self, ts, open_, close, last_bar_of_day=False):
        """Feed one bar. Returns the list of trades made on this bar."""
        made = []
        if not self.started:
            self._start(ts, close)
            if self.trades:
                made.append(self.trades[-1])
            return made
        # fill an order decided on the previous bar's close, at this bar's open
        if self._pending:
            side, sh, reason = self._pending
            self._pending = None
            t = self._fill(ts, side, sh, open_, reason)
            if t:
                if side == "buy" and self.p.mode == "aim":
                    self.pc += t["value"] * self.p.pc_increment
                made.append(t)
        self._bar += 1
        if last_bar_of_day and not self.p.carry:
            t = self._fill(ts, "sell", self.shares, close, "day end")
            if t:
                made.append(t)
            self.started = False            # restart fresh tomorrow
            self._pending = None
            self.capital = self.cash
            return made
        if self._bar % max(1, self.p.check_every) == 0:
            d = self._decide(close)
            if d and d[1] > 0:
                if self.p.execution == "close":
                    t = self._fill(ts, d[0], d[1], close, self.p.mode)
                    if t:
                        if d[0] == "buy" and self.p.mode == "aim":
                            self.pc += t["value"] * self.p.pc_increment
                        made.append(t)
                else:
                    self._pending = (d[0], d[1], self.p.mode)
        return made

    def state(self, price):
        return {"name": self.name, "cash": round(self.cash, 2), "shares": self.shares, "pc": round(self.pc, 2),
                "equity": round(self.equity(price), 2), "costs": round(self.total_costs, 2)}


class StaggeredAIM:
    """Several AIM accounts on the same stock, a new one started every
    `every_days` trading days until `tranches` are running. Capital not yet
    used sits as cash, so results are comparable with a single AIM."""

    def __init__(self, capital: float, tranches: int = 4, every_days: int = 5, params: AIMParams = None,
                 costs: CostModel = None):
        self.capital = float(capital)
        self.n = int(tranches)
        self.every = int(every_days)
        self.params = params or AIMParams()
        self.costs = costs or no_costs()
        self.per = self.capital / self.n
        self.accounts = []
        self.reserve = self.capital
        self._days = 0
        self._last_day = None

    def step(self, ts, open_, close, last_bar_of_day=False):
        day = pd.Timestamp(ts).date()
        if day != self._last_day:
            if self._last_day is not None:
                self._days += 1
            self._last_day = day
            due = min(self.n, 1 + self._days // self.every)
            while len(self.accounts) < due:
                k = len(self.accounts) + 1
                self.accounts.append(AIMAccount(self.per, self.params, self.costs, name="tranche_%d" % k))
                self.reserve -= self.per
        made = []
        for a in self.accounts:
            made.extend(a.step(ts, open_, close, last_bar_of_day))
        return made

    @property
    def trades(self):
        out = []
        for a in self.accounts:
            out.extend(a.trades)
        return sorted(out, key=lambda t: t["ts"])

    @property
    def total_costs(self):
        return sum(a.total_costs for a in self.accounts)

    def equity(self, price):
        return self.reserve + sum(a.equity(price) for a in self.accounts)


def params_dict(p: AIMParams) -> dict:
    return asdict(p)
