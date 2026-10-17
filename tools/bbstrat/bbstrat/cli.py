"""Command line:

  python -m bbstrat.cli aim     --bars ACC.csv [--capital 1000000] [--mode aim|grid] [--safe 0.03]
                                [--grid-pct 0.005] [--intraday] [--staggered 4 --every 5] [--sweep] [--out results]
  python -m bbstrat.cli spread  --quotes SJVN_quotes.csv [--tick 0.05] [--qty 100] [--out results]
  python -m bbstrat.cli demo    (runs everything on synthetic data)

Every run is repeated under: no costs / no brokerage (taxes only) / flat Rs 20 / Zerodha.
"""
import argparse, os, json
from dataclasses import replace
import pandas as pd
from . import (AIMParams, load_bars, load_quotes, synthetic_bars, synthetic_quotes, standard_scenarios, compare_costs,
               aim_maker, staggered_maker, sweep, analyze_gates, compare_quoting_costs, QuoteParams, zerodha, flat_brokerage)


def _save(out, name, obj):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, name)
    if isinstance(obj, pd.DataFrame):
        obj.to_csv(path, index=False)
    else:
        with open(path, "w") as f:
            json.dump(obj, f, indent=2, default=str)
    return path


def cmd_aim(a):
    bars = load_bars(a.bars) if a.bars else synthetic_bars()
    product = "intraday" if a.intraday else "delivery"
    p = AIMParams(mode=a.mode, safe_pct=a.safe, grid_pct=a.grid_pct, grid_value=a.grid_value, carry=not a.intraday,
                  check_every=a.check_every, min_trade_value=a.min_trade)
    models = standard_scenarios(product)
    if a.flat is not None:
        models.append(flat_brokerage(a.flat, product))
    single = compare_costs(bars, aim_maker(a.capital, p), models, a.capital)
    print("\n=== Single AIM (" + product + ") ===\n" + single.to_string(index=False))
    _save(a.out, "aim_single_by_costs.csv", single)
    if a.staggered:
        st = compare_costs(bars, staggered_maker(a.capital, p, a.staggered, a.every), models, a.capital)
        print("\n=== Staggered AIM: %d tranches, one every %d days ===\n" % (a.staggered, a.every) + st.to_string(index=False))
        _save(a.out, "aim_staggered_by_costs.csv", st)
    if a.sweep:
        grid = {"safe_pct": [0.01, 0.02, 0.03, 0.05, 0.08, 0.10], "check_every": [1, 5, 15, 60]} if a.mode == "aim" else \
               {"grid_pct": [0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02], "check_every": [1, 5, 15]}
        cm = zerodha(product)
        sw = sweep(bars, grid, cm, a.capital, base=p, staggered={"tranches": a.staggered, "every_days": a.every} if a.staggered else None)
        print("\n=== Parameter sweep (" + cm.name + "), best on the TEST period ===\n" + sw.to_string(index=False))
        _save(a.out, "aim_sweep.csv", sw)
    print("\nResults saved in: " + os.path.abspath(a.out))


def cmd_spread(a):
    q = load_quotes(a.quotes) if a.quotes else synthetic_quotes()
    g = analyze_gates(q, zerodha("intraday"), a.trade_value, a.wide, a.tick)
    print("\n=== Gate analysis ===\n" + json.dumps(g, indent=2))
    _save(a.out, "gate_analysis.json", g)
    qp = QuoteParams(qty=a.qty, tick=a.tick, min_gate_multiple=a.wide, improve_ticks=a.improve, stop_ticks=a.stop)
    sim = compare_quoting_costs(q, standard_scenarios("intraday"), qp)
    print("\n=== Quoting simulation (front = optimistic queue, back = pessimistic) ===\n" + sim.to_string(index=False))
    _save(a.out, "quoting_by_costs.csv", sim)
    print("\nResults saved in: " + os.path.abspath(a.out))


def main():
    ap = argparse.ArgumentParser(prog="bbstrat")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("aim"); s.add_argument("--bars"); s.add_argument("--capital", type=float, default=1_000_000)
    s.add_argument("--mode", default="aim", choices=["aim", "grid"]); s.add_argument("--safe", type=float, default=0.03)
    s.add_argument("--grid-pct", type=float, default=0.005); s.add_argument("--grid-value", type=float, default=50_000)
    s.add_argument("--check-every", type=int, default=1); s.add_argument("--min-trade", type=float, default=5000)
    s.add_argument("--intraday", action="store_true"); s.add_argument("--staggered", type=int, default=0)
    s.add_argument("--every", type=int, default=5); s.add_argument("--sweep", action="store_true")
    s.add_argument("--flat", type=float, default=None, help="extra scenario: flat brokerage in Rs per order")
    s.add_argument("--out", default="results")
    t = sub.add_parser("spread"); t.add_argument("--quotes"); t.add_argument("--tick", type=float, default=0.05)
    t.add_argument("--qty", type=int, default=100); t.add_argument("--wide", type=float, default=2.0)
    t.add_argument("--improve", type=int, default=0); t.add_argument("--stop", type=int, default=4)
    t.add_argument("--trade-value", type=float, default=100_000); t.add_argument("--out", default="results")
    sub.add_parser("demo")
    a = ap.parse_args()
    if a.cmd == "aim":
        cmd_aim(a)
    elif a.cmd == "spread":
        cmd_spread(a)
    else:
        print("Demo on synthetic data (no real market data)…")
        cmd_aim(ap.parse_args(["aim", "--staggered", "4", "--every", "5", "--sweep", "--out", "results_demo"]))
        cmd_spread(ap.parse_args(["spread", "--out", "results_demo"]))


if __name__ == "__main__":
    main()
