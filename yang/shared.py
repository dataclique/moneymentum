from typing import TypedDict


class LookbackPeriods(TypedDict):
    lookback_periods: int
    n_tokens: int
    time_in_ms: int
    annualized_factor: int
    min_acceptable_return: float


# min_acceptable_return Based on HyperLiquid neutral funding rates.
# See funding comparison page for more details:
# https://app.hyperliquid.xyz/fundingComparison
LOOKBACK_PERIODS_DICT: dict[str, LookbackPeriods] = {
    "1w": {
        "lookback_periods": 52,
        "n_tokens": 2,
        "time_in_ms": 7 * 24 * 60 * 60 * 1000,
        "annualized_factor": 52,
        "min_acceptable_return": 0.0021,  # 0.21%
    },
    "1d": {
        "lookback_periods": 90,
        "n_tokens": 6,
        "time_in_ms": 24 * 60 * 60 * 1000,
        "annualized_factor": 365,
        "min_acceptable_return": 0.0003,  # 0.03%
    },
    "1h": {
        "lookback_periods": 7 * 24,
        "n_tokens": 5,
        "time_in_ms": 60 * 60 * 1000,
        "annualized_factor": 365 * 24,
        "min_acceptable_return": 0.000013,  # 0.0013%
    },
}
