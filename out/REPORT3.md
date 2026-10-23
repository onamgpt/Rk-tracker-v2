# Round 3 — 2023-10-25 to 2026-10-22, 509 liquid stocks. Fit < 2025-10-24 <= Test

## 1. AIM parameter sweep (150 most liquid, Rs 10L each, delivery costs). every = check every N trading days (0 = buy & hold)

Top 15 by median CAGR:
 every  safe  pcinc  block  med_CAGR  mean_CAGR  med_DD  med_test_ret  trades  return_per_DD
     0  0.00    0.0      0     21.26      24.43  -37.53          1.74     0.0          0.566
     1  0.00    1.0      1     16.05      19.40  -35.12          1.89    97.5          0.457
     1  0.00    1.0      0     16.05      19.40  -35.12          1.89    97.5          0.457
     5  0.00    0.5      0     14.89      14.62  -26.47          3.12    99.0          0.563
     5  0.00    0.5      1     14.86      14.60  -26.21          3.24    97.0          0.567
     1  0.00    0.5      1     14.74      15.91  -33.81          1.86   205.5          0.436
     1  0.00    0.5      0     14.74      15.95  -34.00          1.86   213.0          0.434
     5  0.00    1.0      1     14.56      15.55  -34.09          1.93    48.0          0.427
     5  0.00    1.0      0     14.56      15.55  -34.09          1.93    48.0          0.427
     1  0.02    1.0      1     14.55      16.80  -34.75          1.79    81.5          0.419
     1  0.02    1.0      0     14.55      16.80  -34.75          1.79    81.5          0.419
    10  0.02    1.0      0     14.53      14.54  -27.53          2.66    32.0          0.528
    10  0.02    1.0      1     14.53      14.54  -27.53          2.66    32.0          0.528
     1  0.02    0.5      1     14.32      14.83  -27.48          2.96   159.5          0.521
     1  0.02    0.5      0     14.32      14.85  -27.51          2.96   164.0          0.521

Top 15 by return per unit of drawdown:
 every  safe  pcinc  block  med_CAGR  mean_CAGR  med_DD  med_test_ret  trades  return_per_DD
     5  0.15    1.0      1     13.82      13.55  -16.45          2.47    25.0          0.840
     5  0.15    1.0      0     13.82      13.55  -16.45          2.47    25.0          0.840
    21  0.10    1.0      1     13.41      12.94  -16.41          2.51    14.0          0.817
    21  0.10    1.0      0     13.41      12.94  -16.41          2.51    14.0          0.817
     1  0.15    0.5      0     12.74      12.57  -15.81          2.18    42.0          0.806
     1  0.15    0.5      1     12.74      12.57  -15.81          2.18    42.0          0.806
    10  0.15    1.0      1     13.11      13.03  -16.39          2.28    17.0          0.800
    10  0.15    1.0      0     13.11      13.03  -16.39          2.28    17.0          0.800
     5  0.15    0.5      1     12.58      12.44  -15.85          1.92    23.5          0.794
     5  0.15    0.5      0     12.58      12.44  -15.85          1.92    23.5          0.794
     1  0.15    1.0      0     14.24      14.20  -18.04          2.85    47.0          0.789
     1  0.15    1.0      1     14.24      14.20  -18.04          2.85    47.0          0.789
    21  0.10    0.5      1     12.52      12.22  -15.88          1.55    13.0          0.788
    21  0.10    0.5      0     12.52      12.21  -15.88          1.55    13.0          0.788
     5  0.10    0.5      0     12.57      12.59  -16.05          2.39    30.0          0.783

Your current app (every 10, safe 10%, pc 0.5, sell-block on):
 every  safe  pcinc  block  med_CAGR  mean_CAGR  med_DD  med_test_ret  trades  return_per_DD
    10   0.1    0.5      1     12.55      12.33  -16.04          2.02    20.5          0.782

Buy & hold:
 every  safe  pcinc  block  med_CAGR  mean_CAGR  med_DD  med_test_ret  trades  return_per_DD
     0   0.0    0.0      0     21.26      24.43  -37.53          1.74     0.0          0.566

## 2. Swing box -> AIM (delivery costs 0.297% round trip + MTF interest 0.045%/day held)

Combinations profitable in BOTH fit and test (top 40 by test avg net % per trade):
                                       signal            mode  hold_days  target_pct  avg_net_fit  avg_net_test  hit_rate_fit  hit_rate_test  t_fit  t_test  trades_fit  trades_test
                             Fell >= 3% today fail -> AIM 60d          1         3.0        4.282         2.792        34.871         30.132  6.869  -0.304     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 60d          1         3.0        4.171         1.910        28.294         24.448  9.321  -0.269     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 60d          1         2.0        3.098         1.888        52.826         47.878  5.708  -0.899     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 60d          3         3.0        2.750         1.624        56.566         53.211  5.626  -1.251     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 60d          1         1.5        2.326         1.458        64.084         58.384  4.828  -1.499     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 60d          5         3.0        1.950         1.294        66.304         62.208  4.372  -1.374     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 60d          1         2.0        2.982         1.196        45.891         41.083  8.180  -1.077     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 60d          1         1.0        1.620         1.121        75.597         69.731  3.758  -1.206     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 20d          1         3.0        1.323         1.078        34.871         30.132  3.963  -1.291     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 60d          3         3.0        2.634         1.049        50.784         47.686  7.931  -1.580     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 60d          3         2.0        1.868         0.936        70.119         68.011  4.324  -1.851     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 60d          1         0.5        1.066         0.934        85.174         81.809  2.828   0.191     16174.0       8081.0
Fell >= 2% today, in uptrend (above 100d avg) fail -> AIM 60d          1         3.0        3.316         0.899        28.585         25.145  4.962   1.470     14343.0       6379.0
                             Fell >= 2% today fail -> AIM 60d          5         3.0        1.902         0.875        61.558         57.238  6.797  -1.433     32152.0      16856.0
                             Fell >= 2% today fail -> AIM 60d          1         1.5        2.210         0.840        58.043         52.254  7.021  -1.853     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 60d          5         2.0        1.247         0.782        77.383         74.483  3.232  -1.431     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 20d          3         3.0        0.944         0.750        56.566         53.211  1.939  -2.611     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 20d          1         2.0        0.805         0.666        52.826         47.878  2.691  -2.107     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 60d          3         1.5        1.365         0.664        77.600         75.325  3.393  -2.275     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 60d          1         1.0        1.441         0.635        71.426         65.229  5.999  -1.858     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 20d          5         3.0        0.763         0.635        66.304         62.208  1.691  -2.750     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 60d          5         1.5        0.901         0.603        83.288         80.374  2.399  -2.022     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 60d          1         0.5        0.841         0.556        84.184         79.218  4.855  -0.878     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 20d          1         1.5        0.515         0.540        64.084         58.384  2.023  -2.638     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 60d          3         2.0        1.749         0.521        65.713         63.159  6.812  -2.422     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 60d          3         1.0        0.943         0.514        84.735         82.465  2.359  -2.203     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 20d          1         3.0        1.293         0.501        28.294         24.448  5.786  -1.391     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 60d          3         0.5        0.593         0.471        90.726         89.816  1.314  -0.348     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 60d          5         2.0        1.219         0.463        73.849         70.420  5.943  -2.112     32152.0      16856.0
Fell >= 2% today, in uptrend (above 100d avg) fail -> AIM 60d          3         3.0        2.054         0.460        50.924         48.174  3.970   0.564     14343.0       6379.0
                             Fell >= 3% today fail -> AIM 60d          5         1.0        0.591         0.452        88.809         85.831  1.757  -2.090     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 20d          1         1.0        0.305         0.431        75.597         69.731  1.144  -2.440     16174.0       8081.0
Fell >= 2% today, in uptrend (above 100d avg) fail -> AIM 60d          1         2.0        2.311         0.427        46.294         42.734  4.198   0.751     14343.0       6379.0
                             Fell >= 3% today fail -> AIM 20d          1         0.5        0.166         0.394        85.174         81.809  1.382  -1.542     16174.0       8081.0
Fell >= 2% today, in uptrend (above 100d avg) fail -> AIM 60d          5         3.0        1.633         0.378        61.201         58.066  3.462   0.419     14343.0       6379.0
                             Fell >= 3% today fail -> AIM 20d          3         2.0        0.538         0.377        70.119         68.011  0.964  -3.497     16174.0       8081.0
                             Fell >= 3% today fail -> AIM 60d          5         0.5        0.315         0.367        93.632         91.758  1.072  -0.744     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 20d          3         3.0        0.859         0.339        50.784         47.686  4.080  -2.416     32152.0      16856.0
                             Fell >= 3% today fail -> AIM 20d          5         2.0        0.443         0.328        77.383         74.483  0.530  -3.224     16174.0       8081.0
                             Fell >= 2% today fail -> AIM 20d          5         3.0        0.692         0.311        61.558         57.238  3.487  -2.344     32152.0      16856.0

Baseline (random entry), sell mode:
                         signal                mode  hold_days  target_pct  avg_net_fit  avg_net_test  hit_rate_fit  hit_rate_test  t_fit  t_test  trades_fit  trades_test
Every stock, every day (random) sell at day-H close          1         0.5       -0.128        -0.309        80.847         73.795 -3.818  -6.015    222718.0     111419.0
Every stock, every day (random) sell at day-H close          1         1.0       -0.199        -0.354        61.936         56.014 -5.058  -6.211    222718.0     111419.0
Every stock, every day (random) sell at day-H close          1         1.5       -0.234        -0.367        46.457         41.934 -5.312  -6.039    222718.0     111419.0
Every stock, every day (random) sell at day-H close          1         2.0       -0.254        -0.371        34.804         31.304 -5.353  -5.873    222718.0     111419.0
Every stock, every day (random) sell at day-H close          1         3.0       -0.267        -0.377        20.143         17.650 -5.181  -5.695    222718.0     111419.0
Every stock, every day (random) sell at day-H close          3         0.5       -0.132        -0.297        88.918         84.726 -3.708  -5.660    222718.0     111419.0
Every stock, every day (random) sell at day-H close          3         1.0       -0.192        -0.358        77.853         73.133 -4.075  -5.649    222718.0     111419.0
Every stock, every day (random) sell at day-H close          3         1.5       -0.214        -0.381        67.255         62.567 -3.739  -5.337    222718.0     111419.0
Every stock, every day (random) sell at day-H close          3         2.0       -0.216        -0.394        57.849         53.205 -3.287  -5.045    222718.0     111419.0
Every stock, every day (random) sell at day-H close          3         3.0       -0.198        -0.420        42.580         37.917 -2.543  -4.797    222718.0     111419.0
Every stock, every day (random) sell at day-H close          5         0.5       -0.122        -0.301        91.623         88.058 -3.419  -5.730    222718.0     111419.0
Every stock, every day (random) sell at day-H close          5         1.0       -0.178        -0.376        83.242         78.752 -3.538  -5.809    222718.0     111419.0
Every stock, every day (random) sell at day-H close          5         1.5       -0.192        -0.411        75.007         70.002 -3.053  -5.550    222718.0     111419.0
Every stock, every day (random) sell at day-H close          5         2.0       -0.186        -0.437        67.320         61.988 -2.522  -5.312    222718.0     111419.0
Every stock, every day (random) sell at day-H close          5         3.0       -0.150        -0.485        53.816         47.964 -1.632  -5.093    222718.0     111419.0