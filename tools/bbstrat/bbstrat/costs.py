"""
Trading cost models for Indian equities (NSE).

Every simulation in this package takes a CostModel, so the same strategy can
be run side by side "with brokerage", "without brokerage" (statutory charges
only), with a flat fee, or with no costs at all.

All rates are parameters. The defaults are typical NSE / Zerodha-style rates
and MUST be checked against your broker's current schedule before relying on
any result.
"""
from dataclasses import dataclass, replace


@dataclass
class CostModel:
    name: str = "zerodha_intraday"
    # Brokerage: "none" | "flat" | "percent" | "percent_capped"
    brokerage_mode: str = "percent_capped"
    flat_per_order: float = 20.0          # Rs per executed order (flat mode)
    pct_per_order: float = 0.0003         # 0.03% (percent modes)
    cap_per_order: float = 20.0           # cap for percent_capped
    # Product: "intraday" (MIS) or "delivery" (CNC)
    product: str = "intraday"
    # Statutory and exchange charges (set statutory=False for a pure no-cost run)
    statutory: bool = True
    stt_intraday_sell: float = 0.00025    # 0.025% on sell side, intraday
    stt_delivery: float = 0.001           # 0.1% on buy and sell, delivery
    exchange_txn: float = 0.0000297       # NSE transaction charge, both sides
    sebi_fee: float = 0.000001            # Rs 10 per crore, both sides
    stamp_intraday_buy: float = 0.00003   # 0.003% on buy side, intraday
    stamp_delivery_buy: float = 0.00015   # 0.015% on buy side, delivery
    gst: float = 0.18                     # on brokerage + exchange + SEBI
    dp_charge_per_sell: float = 15.34     # delivery sells only, per scrip per day (approx.)

    def brokerage(self, value: float) -> float:
        m = self.brokerage_mode
        if m == "none":
            return 0.0
        if m == "flat":
            return self.flat_per_order
        if m == "percent":
            return self.pct_per_order * value
        if m == "percent_capped":
            return min(self.cap_per_order, self.pct_per_order * value)
        raise ValueError("unknown brokerage_mode: " + m)

    def order_cost(self, side: str, value: float) -> float:
        """Total cost in rupees of one executed order. side = 'buy' or 'sell'."""
        value = abs(float(value))
        if value <= 0:
            return 0.0
        brk = self.brokerage(value)
        if not self.statutory:
            return brk
        intraday = self.product == "intraday"
        if intraday:
            stt = self.stt_intraday_sell * value if side == "sell" else 0.0
            stamp = self.stamp_intraday_buy * value if side == "buy" else 0.0
            dp = 0.0
        else:
            stt = self.stt_delivery * value
            stamp = self.stamp_delivery_buy * value if side == "buy" else 0.0
            dp = self.dp_charge_per_sell if side == "sell" else 0.0
        exch = self.exchange_txn * value
        sebi = self.sebi_fee * value
        gst = self.gst * (brk + exch + sebi)
        return brk + stt + exch + sebi + stamp + gst + dp

    def round_trip_pct(self, value: float) -> float:
        """Cost of buy + sell of `value` rupees each, as % of value."""
        return (self.order_cost("buy", value) + self.order_cost("sell", value)) / value * 100.0


# ---- Ready-made scenarios -------------------------------------------------

def no_costs() -> CostModel:
    return CostModel(name="no_costs", brokerage_mode="none", statutory=False)


def statutory_only(product: str = "intraday") -> CostModel:
    """'Without brokerage' — zero brokerage, but taxes and exchange charges still apply."""
    return CostModel(name="no_brokerage_" + product, brokerage_mode="none", product=product)


def flat_brokerage(amount: float = 20.0, product: str = "intraday") -> CostModel:
    return CostModel(name="flat_%g_%s" % (amount, product), brokerage_mode="flat", flat_per_order=amount, product=product)


def zerodha(product: str = "intraday") -> CostModel:
    if product == "delivery":
        return CostModel(name="zerodha_delivery", brokerage_mode="none", product="delivery")
    return CostModel(name="zerodha_intraday", brokerage_mode="percent_capped", product="intraday")


def standard_scenarios(product: str = "intraday"):
    """The comparison set used by default: no costs, no brokerage, flat Rs 20, Zerodha."""
    return [no_costs(), statutory_only(product), flat_brokerage(20.0, product), zerodha(product)]


def with_name(model: CostModel, name: str) -> CostModel:
    return replace(model, name=name)
