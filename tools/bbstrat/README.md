# bbstrat — AIM, staggered AIM and "gate" (bid/ask spread) research toolkit

Simulation and signals only — this code never sends orders.

## Install
    pip install pandas numpy openpyxl

## Data it needs
**Minute bars** (for AIM): CSV/Excel per stock with `ts, open, high, low, close, volume` (IST timestamps).
**Quotes** (for the gate strategy): one row per change of best bid/offer, or per second:
`ts, bid, ask, bid_qty, ask_qty, last, volume` (volume = cumulative for the day).
Different column names? Pass `mapping={"Time":"ts","Last":"close"}` to `load_bars` / `load_quotes`.

## Run
    python -m bbstrat.cli demo                                   # synthetic data
    python -m bbstrat.cli aim --bars ACC.csv --safe 0.03 --staggered 4 --every 5 --sweep
    python -m bbstrat.cli aim --bars ACC.csv --mode grid --grid-pct 0.005 --intraday
    python -m bbstrat.cli spread --quotes SJVN_quotes.csv --tick 0.05 --qty 100

Every run is repeated under four cost scenarios: **no costs**, **no brokerage (taxes only)**,
**flat ₹20 per order**, **Zerodha** — add your own with `--flat 10` or a `CostModel`.
All tax/exchange rates are parameters in `bbstrat/costs.py`; check them against your broker.

## Live use on a terminal
See `bbstrat/live.py`: `BarBuilder` (ticks → 1-min bars), `GateMonitor` (running gate stats),
`LiveAIM` (suggests orders; call `confirm_fill()` with real executions).
