# BB Lab (research branch)
Research runner for the BB 5-minute data. `lab_job.py <unzipped-folder> <out>` loads any layout, then tests:
AIM family (biweekly / daily / 5-min), Day-Night AIM overlay, rebalancing band, and the Gap-Fade intraday strategy,
each with no costs / no brokerage / Zerodha costs, fit on the first 2/3 of dates and tested on the last 1/3.
Only summary tables are committed; raw data never is.
