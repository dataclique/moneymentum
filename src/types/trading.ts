export interface TradingData {
  timestamp: string;
  close: number;
  volume: number;
  ticker: string;
  log_return: number;
  cum_return: number;
  autocorrelation: number;
  stddev: number;
  annualized_volatility: number;
  sma: number;
  mean_return: number;
  price_stddev: number;
  return_stddev: number;
  price_zscore: number;
  covariance: number;
  beta: number;
  information_discreteness: number;
  sharpe: number;
  log_return_above_mar: number;
  downside_deviation: number;
  sortino: number;
} 