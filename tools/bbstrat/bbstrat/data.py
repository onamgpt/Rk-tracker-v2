"""
Data in and out.

Two kinds of market data are used:

  BARS   (for AIM / staggered AIM)  — one row per minute (or any interval):
         ts, open, high, low, close, volume

  QUOTES (for spread / gate work)   — one row per update of the order book top:
         ts, bid, ask, bid_qty, ask_qty, last, volume (cumulative day volume)

If the BB terminal uses different column names, pass a `mapping`, e.g.
    load_bars("acc.csv", mapping={"Time": "ts", "Last Price": "close", ...})
or build the DataFrame yourself and call normalize_bars / normalize_quotes.
"""
import numpy as np
import pandas as pd

BAR_COLS = ["ts", "open", "high", "low", "close", "volume"]
QUOTE_COLS = ["ts", "bid", "ask", "bid_qty", "ask_qty", "last", "volume"]


def _read(path):
    p = str(path).lower()
    if p.endswith((".xlsx", ".xls")):
        return pd.read_excel(path)
    if p.endswith(".parquet"):
        return pd.read_parquet(path)
    return pd.read_csv(path)


def normalize_bars(df: pd.DataFrame, mapping: dict = None) -> pd.DataFrame:
    if mapping:
        df = df.rename(columns=mapping)
    df = df.rename(columns={c: c.strip().lower() for c in df.columns})
    if "close" not in df.columns:
        raise ValueError("bars need at least ts and close columns")
    for c in ["open", "high", "low"]:
        if c not in df.columns:
            df[c] = df["close"]
    if "volume" not in df.columns:
        df["volume"] = 0
    df["ts"] = pd.to_datetime(df["ts"])
    df = df[BAR_COLS].dropna(subset=["close"]).sort_values("ts").reset_index(drop=True)
    return df


def normalize_quotes(df: pd.DataFrame, mapping: dict = None) -> pd.DataFrame:
    if mapping:
        df = df.rename(columns=mapping)
    df = df.rename(columns={c: c.strip().lower() for c in df.columns})
    for c in ["bid_qty", "ask_qty", "last", "volume"]:
        if c not in df.columns:
            df[c] = np.nan if c == "last" else 0
    df["ts"] = pd.to_datetime(df["ts"])
    df = df[QUOTE_COLS].dropna(subset=["bid", "ask"]).sort_values("ts").reset_index(drop=True)
    return df


def load_bars(path, mapping: dict = None) -> pd.DataFrame:
    return normalize_bars(_read(path), mapping)


def load_quotes(path, mapping: dict = None) -> pd.DataFrame:
    return normalize_quotes(_read(path), mapping)


# ---- Synthetic data (for testing the code before real BB data is plugged in) ----

def market_minutes(days: int, start="2026-01-05"):
    out = []
    d = pd.Timestamp(start)
    while len(out) < days:
        if d.weekday() < 5:
            out.append(d)
        d += pd.Timedelta(days=1)
    idx = []
    for day in out:
        idx.extend(pd.date_range(day + pd.Timedelta(hours=9, minutes=15), day + pd.Timedelta(hours=15, minutes=29), freq="1min"))
    return pd.DatetimeIndex(idx)


def synthetic_bars(days=20, price=2000.0, vol_daily=0.015, mean_revert=0.02, seed=1) -> pd.DataFrame:
    """Mean-reverting random walk — a 'sideways' stock, the kind AIM likes."""
    rng = np.random.default_rng(seed)
    ts = market_minutes(days)
    n = len(ts)
    sig = vol_daily / np.sqrt(375)
    p = np.empty(n)
    p[0] = price
    for i in range(1, n):
        p[i] = p[i - 1] * (1 + rng.normal(0, sig) + mean_revert * (price - p[i - 1]) / price / 375)
    close = np.round(p / 0.05) * 0.05
    high = close * (1 + np.abs(rng.normal(0, sig / 2, n)))
    low = close * (1 - np.abs(rng.normal(0, sig / 2, n)))
    return pd.DataFrame({"ts": ts, "open": np.r_[close[0], close[:-1]], "high": np.maximum(high, close),
                         "low": np.minimum(low, close), "close": close, "volume": rng.integers(100, 5000, n)})


def synthetic_quotes(seconds=6 * 3600, price=100.0, tick=0.05, seed=2) -> pd.DataFrame:
    """One update per second with a gate that widens and narrows."""
    rng = np.random.default_rng(seed)
    ts = pd.date_range("2026-01-05 09:15:00", periods=seconds, freq="1s")
    mid = price + np.cumsum(rng.normal(0, 0.01, seconds))
    gate_ticks = np.clip(np.round(2 + 3 * np.sin(np.arange(seconds) / 400) + rng.normal(0, 1, seconds)), 1, 10)
    bid = np.round((mid - gate_ticks * tick / 2) / tick) * tick
    ask = bid + gate_ticks * tick
    trade = rng.random(seconds) < 0.15
    side = rng.random(seconds) < 0.5
    last = np.where(side, ask, bid)
    vol = np.cumsum(np.where(trade, rng.integers(1, 200, seconds), 0))
    return pd.DataFrame({"ts": ts, "bid": bid, "ask": ask, "bid_qty": rng.integers(50, 2000, seconds),
                         "ask_qty": rng.integers(50, 2000, seconds), "last": last, "volume": vol})
