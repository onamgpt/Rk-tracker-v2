"""bbstrat — AIM (incl. staggered AIM) and bid/ask "gate" research toolkit
for minute / tick data from the BB terminal. Simulation and signals only:
this package never sends orders."""
from .costs import CostModel, no_costs, statutory_only, flat_brokerage, zerodha, standard_scenarios
from .data import load_bars, load_quotes, normalize_bars, normalize_quotes, synthetic_bars, synthetic_quotes
from .aim import AIMParams, AIMAccount, StaggeredAIM
from .backtest import run, compare_costs, sweep, aim_maker, staggered_maker
from .spread import analyze_gates, simulate_quoting, compare_quoting_costs, QuoteParams
from .live import BarBuilder, GateMonitor, LiveAIM

__version__ = "0.1.0"
