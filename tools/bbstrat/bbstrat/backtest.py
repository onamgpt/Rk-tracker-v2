"""
Backtests on minute (or any) bars.

  run(bars, make, costs)            one strategy, one cost model
  compare_costs(bars, make, models) same strategy under several cost models —
                                    e.g. no costs / no brokerage / flat / Zerodha
  sweep(bars, grid, ...)            many parameter sets; picks on the first part
                                    of the data (train) and checks on the rest
                                    (test), to avoid settings that only fit the past

`make(costs)` must return a fresh strategy object with .step(), .trades,
.total_costs and .equity(price) — AIMAccount and StaggeredAIM both qualify.
"""
import itertools
from dataclasses import replace
import numpy as np
import pandas as pd

from .aim import AIMAccount, StaggeredAIM, AIMParams
from .costs import CostModel, standard_scenarios


def _last_bar_flags(bars: pd.DataFrame) -> np.ndarray:
    d = bars["ts"].dt.date.values
    flags = np.zeros(len(bars), dtype=bool)
    flags[:-1] = d[:-1] != d[1:]
    flags[-1] = True
    return flags


def run(bars: pd.DataFrame, make, costs: CostModel, capital_hint: float = None) -> dict:
    strat = make(costs)
    cap0 = float(capital_hint or getattr(strat, "capital", 0) or 0)
    last = _last_bar_flags(bars)
    ts = bars["ts"].values
    op = bars["open"].values
    cl = bars["close"].values
    eq_ts, eq_val = [], []
    for i in range(len(bars)):
        strat.step(pd.Timestamp(ts[i]), float(op[i]), float(cl[i]), bool(last[i]))
        if last[i]:
            eq_ts.append(pd.Timestamp(ts[i]).normalize())
            eq_val.append(strat.equity(float(cl[i])))
    equity = pd.Series(eq_val, index=pd.DatetimeIndex(eq_ts), name="equity")
    trades = pd.DataFrame(strat.trades)
    capital = cap0 or (equity.iloc[0] if len(equity) else 0)
    return {"strategy": strat, "equity": equity, "trades": trades, "summary": summarize(equity, trades, capital, bars, costs)}


def summarize(equity: pd.Series, trades: pd.DataFrame, capital: float, bars: pd.DataFrame, costs: CostModel) -> dict:
    if not len(equity):
        return {}
    start = float(capital)
    end = float(equity.iloc[-1])
    daily = equity.pct_change().fillna(equity.iloc[0] / start - 1)
    peak = equity.cummax()
    dd = float(((equity - peak) / peak).min() * 100)
    days = len(equity)
    n = len(trades)
    cost_total = float(trades["cost"].sum()) if n else 0.0
    gross = end - start + cost_total
    first, lastp = float(bars["close"].iloc[0]), float(bars["close"].iloc[-1])
    return {
        "costs_model": costs.name,
        "start_capital": round(start, 2),
        "end_equity": round(end, 2),
        "return_pct": round((end / start - 1) * 100, 3),
        "avg_daily_return_pct": round(float(daily.mean()) * 100, 4),
        "worst_day_pct": round(float(daily.min()) * 100, 3),
        "best_day_pct": round(float(daily.max()) * 100, 3),
        "losing_days_pct": round(float((daily < 0).mean()) * 100, 1),
        "max_drawdown_pct": round(dd, 3),
        "days": days,
        "trades": n,
        "trades_per_day": round(n / max(1, days), 2),
        "total_costs": round(cost_total, 2),
        "costs_share_of_gross_pct": round(cost_total / gross * 100, 1) if gross > 0 else None,
        "buy_and_hold_pct": round((lastp / first - 1) * 100, 3),
    }


def compare_costs(bars: pd.DataFrame, make, models=None, capital: float = None) -> pd.DataFrame:
    """Same strategy, several cost models, one table."""
    models = models or standard_scenarios()
    rows = [run(bars, make, m, capital)["summary"] for m in models]
    return pd.DataFrame(rows)


def aim_maker(capital: float, params: AIMParams):
    return lambda costs: AIMAccount(capital, params, costs)


def staggered_maker(capital: float, params: AIMParams, tranches=4, every_days=5):
    return lambda costs: StaggeredAIM(capital, tranches, every_days, params, costs)


def sweep(bars: pd.DataFrame, grid: dict, costs: CostModel, capital: float = 1_000_000,
          base: AIMParams = None, train_frac: float = 0.6, staggered: dict = None, top: int = 15) -> pd.DataFrame:
    """Try every combination in `grid` (AIMParams field -> list of values).
    Ranks by test-period return per unit of drawdown. Returns the top rows."""
    base = base or AIMParams()
    days = bars["ts"].dt.normalize().unique()
    cut = days[max(1, int(len(days) * train_frac)) - 1]
    train = bars[bars["ts"].dt.normalize() <= cut].reset_index(drop=True)
    test = bars[bars["ts"].dt.normalize() > cut].reset_index(drop=True)
    keys = list(grid.keys())
    rows = []
    for combo in itertools.product(*[grid[k] for k in keys]):
        p = replace(base, **dict(zip(keys, combo)))
        mk = staggered_maker(capital, p, **staggered) if staggered else aim_maker(capital, p)
        tr = run(train, mk, costs, capital)["summary"]
        te = run(test, mk, costs, capital)["summary"] if len(test) else {}
        row = dict(zip(keys, combo))
        row.update({"train_return_pct": tr.get("return_pct"), "train_trades_per_day": tr.get("trades_per_day"),
                    "test_return_pct": te.get("return_pct"), "test_max_dd_pct": te.get("max_drawdown_pct"),
                    "test_trades_per_day": te.get("trades_per_day"), "test_costs": te.get("total_costs"),
                    "test_buy_hold_pct": te.get("buy_and_hold_pct")})
        dd = abs(row["test_max_dd_pct"] or 0) or 0.01
        row["score"] = round((row["test_return_pct"] or 0) / dd, 3)
        rows.append(row)
    df = pd.DataFrame(rows).sort_values(["score", "test_return_pct"], ascending=False)
    return df.head(top).reset_index(drop=True)
