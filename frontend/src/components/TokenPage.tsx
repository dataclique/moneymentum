import * as React from "react";
import { Link, useParams } from "react-router-dom";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
} from "lightweight-charts";
import type { IChartApi, ISeriesApi } from "lightweight-charts";

export interface IOHLCData {
  readonly close: number;
  readonly date: Date;
  readonly high: number;
  readonly low: number;
  readonly open: number;
  readonly volume: number;
}

interface TradingData {
  timestamp: string;
  close: number;
  volume: number;
  ticker: string;
  log_return: number | null;
  cum_return: number | null;
  autocorrelation: number | null;
  stddev: number | null;
  annualized_volatility: number | null;
  sma: number | null;
  mean_return: number | null;
  price_stddev: number | null;
  return_stddev: number | null;
  price_zscore: number | null;
  covariance: number | null;
  beta: number | null;
  information_discreteness: number | null;
  sharpe: number | null;
  log_return_above_mar: number | null;
  downside_deviation: number | null;
  sortino: number | null;
}

// Available metrics for selection
const AVAILABLE_METRICS = [
  { value: "price", label: "Price Chart (OHLC)" },
  { value: "log_return", label: "Log Return" },
  { value: "cum_return", label: "Cumulative Return" },
  { value: "autocorrelation", label: "Autocorrelation" },
  { value: "stddev", label: "Standard Deviation" },
  { value: "annualized_volatility", label: "Annualized Volatility" },
  { value: "sma", label: "Simple Moving Average" },
  { value: "mean_return", label: "Mean Return" },
  { value: "price_stddev", label: "Price Standard Deviation" },
  { value: "return_stddev", label: "Return Standard Deviation" },
  { value: "price_zscore", label: "Price Z-Score" },
  { value: "covariance", label: "Covariance" },
  { value: "beta", label: "Beta" },
  { value: "information_discreteness", label: "Information Discreteness" },
  { value: "sharpe", label: "Sharpe Ratio" },
  { value: "log_return_above_mar", label: "Log Return Above MAR" },
  { value: "downside_deviation", label: "Downside Deviation" },
  { value: "sortino", label: "Sortino Ratio" },
];

// Transform trading data to OHLC format for price chart
const transformToOHLC = (data: TradingData[]): IOHLCData[] => {
  return data
    .filter((item) => item.close !== null && item.close !== undefined)
    .map((item) => ({
      date: new Date(item.timestamp),
      close: item.close,
      open: item.close, // Using close as open since we don't have separate OHLC data
      high: item.close,
      low: item.close,
      volume: item.volume || 0,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .filter((item, index, array) => {
      // Remove duplicates based on date (keep the last one for each date)
      if (index === array.length - 1) return true;
      const currentDate = item.date.toISOString().split("T")[0];
      const nextDate = array[index + 1].date.toISOString().split("T")[0];
      return currentDate !== nextDate;
    });
};

// Transform trading data to line chart format for metrics
const transformToLineData = (
  data: TradingData[],
  metric: string,
): { time: string; value: number }[] => {
  const processedData = data
    .filter((item) => {
      const value = (item as any)[metric];
      return value !== null && value !== undefined && !isNaN(value);
    })
    .map((item) => ({
      time: item.timestamp.split("T")[0], // Convert to YYYY-MM-DD format
      value: (item as any)[metric] as number,
    }))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  // Remove duplicates by keeping the last value for each date
  const uniqueData: { time: string; value: number }[] = [];
  const timeSet = new Set<string>();

  for (let i = processedData.length - 1; i >= 0; i--) {
    const item = processedData[i];
    if (!timeSet.has(item.time)) {
      timeSet.add(item.time);
      uniqueData.unshift(item);
    }
  }

  return uniqueData;
};

// Chart Component using TradingView Lightweight Charts
interface ChartComponentProps {
  data: TradingData[];
  selectedMetric: string;
  height?: number;
}

const ChartComponent: React.FC<ChartComponentProps> = (
  { data, selectedMetric, height = 600 },
) => {
  const chartContainerRef = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<ISeriesApi<any> | null>(null);
  const volumeSeriesRef = React.useRef<ISeriesApi<any> | null>(null);

  React.useEffect(() => {
    if (!chartContainerRef.current) return;

    try {
      // Create chart
      const chart = createChart(chartContainerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: "#1f2937" },
          textColor: "#d1d5db",
        },
        grid: {
          vertLines: { color: "#374151" },
          horzLines: { color: "#374151" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
        },
        rightPriceScale: {
          borderColor: "#485563",
        },
        timeScale: {
          borderColor: "#485563",
          timeVisible: true,
          secondsVisible: false,
        },
        width: chartContainerRef.current.clientWidth,
        height: height,
      });

      chartRef.current = chart;

      // Handle resize
      const handleResize = () => {
        if (chartContainerRef.current && chartRef.current) {
          const newHeight = window.innerHeight - 80; // Account for header
          chartRef.current.applyOptions({
            width: chartContainerRef.current.clientWidth,
            height: newHeight,
          });
        }
      };

      window.addEventListener("resize", handleResize);

      return () => {
        window.removeEventListener("resize", handleResize);

        // Clean up series references first
        if (seriesRef.current) {
          seriesRef.current = null;
        }
        if (volumeSeriesRef.current) {
          volumeSeriesRef.current = null;
        }

        // Then remove the chart
        if (chartRef.current) {
          chartRef.current.remove();
          chartRef.current = null;
        }
      };
    } catch (error) {
      console.error("Error creating chart:", error);
    }
  }, [height]);

  React.useEffect(() => {
    if (!chartRef.current || !data.length) return;

    try {
      // Remove existing series safely
      if (seriesRef.current && chartRef.current) {
        try {
          chartRef.current.removeSeries(seriesRef.current);
        } catch (error) {
          console.warn("Error removing main series:", error);
        }
        seriesRef.current = null;
      }
      if (volumeSeriesRef.current && chartRef.current) {
        try {
          chartRef.current.removeSeries(volumeSeriesRef.current);
        } catch (error) {
          console.warn("Error removing volume series:", error);
        }
        volumeSeriesRef.current = null;
      }

      if (selectedMetric === "price") {
        // Create candlestick series for price data
        const candlestickSeries = chartRef.current.addSeries(
          CandlestickSeries,
          {
            upColor: "#26a69a",
            downColor: "#ef5350",
            borderVisible: false,
            wickUpColor: "#26a69a",
            wickDownColor: "#ef5350",
          },
        );

        const ohlcData = transformToOHLC(data);
        const chartData = ohlcData.map((item) => ({
          time: item.date.toISOString().split("T")[0], // Convert to YYYY-MM-DD
          open: item.open,
          high: item.high,
          low: item.low,
          close: item.close,
        }));

        console.log("Chart data sample:", chartData.slice(0, 5));
        console.log("Chart data length:", chartData.length);

        // Validate data doesn't have duplicates
        const times = chartData.map((d) => d.time);
        const uniqueTimes = new Set(times);
        if (times.length !== uniqueTimes.size) {
          console.warn("Duplicate timestamps detected in chart data");
          // Remove duplicates again as a safety measure
          const uniqueChartData = chartData.filter((item, index, array) => {
            return index === 0 || item.time !== array[index - 1].time;
          });
          candlestickSeries.setData(uniqueChartData);
        } else {
          candlestickSeries.setData(chartData);
        }

        seriesRef.current = candlestickSeries;

        // Add volume series only if we have volume data
        if (ohlcData.some((item) => item.volume > 0)) {
          const volumeSeries = chartRef.current.addSeries(HistogramSeries, {
            color: "#26a69a",
            priceFormat: {
              type: "volume",
            },
            priceScaleId: "", // Set as an overlay
          });

          const volumeData = ohlcData.map((item) => ({
            time: item.date.toISOString().split("T")[0],
            value: item.volume,
            color: item.close >= item.open ? "#26a69a80" : "#ef535080", // Semi-transparent
          }));

          // Validate volume data
          const volumeTimes = volumeData.map((d) => d.time);
          const uniqueVolumeTimes = new Set(volumeTimes);
          if (volumeTimes.length !== uniqueVolumeTimes.size) {
            console.warn("Duplicate timestamps detected in volume data");
            const uniqueVolumeData = volumeData.filter((item, index, array) => {
              return index === 0 || item.time !== array[index - 1].time;
            });
            volumeSeries.setData(uniqueVolumeData);
          } else {
            volumeSeries.setData(volumeData);
          }

          volumeSeriesRef.current = volumeSeries;
        }
      } else {
        // Create line series for metrics
        const lineData = transformToLineData(data, selectedMetric);
        console.log("Line data sample:", lineData.slice(0, 5));
        console.log("Line data length:", lineData.length);

        // Calculate the range of values to determine appropriate precision
        const values = lineData.map((d) => d.value);
        const minValue = Math.min(...values);
        const maxValue = Math.max(...values);
        const range = Math.abs(maxValue - minValue);
        const avgAbsValue = values.reduce((sum, v) => sum + Math.abs(v), 0) /
          values.length;

        // Determine precision and format based on the metric type
        let precision = 2;
        let priceFormat: any = { type: "price" };

        // Handle edge case where all values are very close to zero
        if (range < 0.0000001 && avgAbsValue < 0.000001) {
          precision = 8;
        } else if (
          selectedMetric.includes("return") || selectedMetric === "sharpe" ||
          selectedMetric === "sortino"
        ) {
          // For returns and ratios, use more precision
          if (range < 0.0001) {
            precision = 6;
          } else if (range < 0.001) {
            precision = 5;
          } else if (range < 0.01) {
            precision = 4;
          } else if (range < 0.1) {
            precision = 3;
          }

          priceFormat = {
            type: "price",
            precision: precision,
            minMove: Math.pow(10, -precision),
          };
        } else if (
          selectedMetric.includes("volatility") ||
          selectedMetric.includes("stddev")
        ) {
          // For volatility metrics
          precision = range < 0.001 ? 5 : range < 0.01 ? 4 : 3;
          priceFormat = {
            type: "price",
            precision: precision,
            minMove: Math.pow(10, -precision),
          };
        } else {
          // General case
          if (range < 0.001) {
            precision = 6;
          } else if (range < 0.01) {
            precision = 5;
          } else if (range < 0.1) {
            precision = 4;
          } else if (range < 1) {
            precision = 3;
          }

          priceFormat = {
            type: "price",
            precision: precision,
            minMove: Math.pow(10, -precision),
          };
        }

        console.log(
          `Metric: ${selectedMetric}, Value range: ${minValue.toFixed(8)} to ${
            maxValue.toFixed(8)
          }, avg abs: ${avgAbsValue.toFixed(8)}, using precision: ${precision}`,
        );

        const lineSeries = chartRef.current.addSeries(LineSeries, {
          color: "#2563eb",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 6,
          crosshairMarkerBorderColor: "#2563eb",
          crosshairMarkerBackgroundColor: "#2563eb",
          priceFormat: priceFormat,
        });

        // Validate line data
        const lineTimes = lineData.map((d) => d.time);
        const uniqueLineTimes = new Set(lineTimes);
        if (lineTimes.length !== uniqueLineTimes.size) {
          console.warn("Duplicate timestamps detected in line data");
        }

        lineSeries.setData(lineData);
        seriesRef.current = lineSeries;

        // Set visible range to show data properly
        if (lineData.length > 0) {
          chartRef.current.priceScale("right").applyOptions({
            autoScale: true,
          });
        }
      }

      // Fit content to show all data
      chartRef.current.timeScale().fitContent();
    } catch (error) {
      console.error("Error updating chart data:", error);
    }
  }, [data, selectedMetric]);

  return (
    <div
      ref={chartContainerRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: `${height}px`,
      }}
    />
  );
};

// Main TokenPage component
const TokenPage: React.FC = () => {
  const { ticker } = useParams<{ ticker: string }>();
  const [data, setData] = React.useState<TradingData[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = React.useState("price");
  const [windowHeight, setWindowHeight] = React.useState(
    typeof window !== "undefined" ? window.innerHeight : 600,
  );

  // Handle window resize
  React.useEffect(() => {
    const handleResize = () => {
      setWindowHeight(window.innerHeight);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  React.useEffect(() => {
    if (!ticker) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(
          `http://localhost:8000/api/token/${ticker}`,
        );
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        if (result.message) {
          setError(result.message);
        } else {
          setData(result.data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [ticker]);

  // Memoize the selected metric label
  const selectedMetricLabel = React.useMemo(() => {
    return AVAILABLE_METRICS.find((m) => m.value === selectedMetric)?.label ||
      selectedMetric;
  }, [selectedMetric]);

  const handleMetricChange = React.useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedMetric(e.target.value);
    },
    [],
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-lg text-white">Loading data for {ticker}...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center">
          <div className="text-red-400 mb-4">Error: {error}</div>
          <Link
            to="/"
            className="text-blue-400 hover:text-blue-300 underline"
          >
            ← Back to Main Page
          </Link>
        </div>
      </div>
    );
  }

  // Calculate chart height (full viewport minus header and padding)
  const chartHeight = Math.max(windowHeight - 140, 400); // Minimum 400px height

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Link
              to="/"
              className="text-blue-400 hover:text-blue-300 transition-colors"
            >
              ← Back
            </Link>
            <h1 className="text-2xl font-bold text-white">
              {ticker} - {selectedMetricLabel}
            </h1>
          </div>
          <select
            id="metric-select"
            value={selectedMetric}
            onChange={handleMetricChange}
            className="bg-gray-700 border border-gray-600 text-white text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5 min-w-48"
          >
            {AVAILABLE_METRICS.map((metric) => (
              <option key={metric.value} value={metric.value}>
                {metric.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Chart Container */}
      <div className="flex-1 p-6 overflow-hidden">
        {data.length === 0
          ? (
            <div className="flex items-center justify-center h-full text-gray-400">
              No data available for {selectedMetricLabel}
            </div>
          )
          : (
            <div className="w-full h-full bg-gray-800 rounded-lg overflow-hidden">
              <ChartComponent
                data={data}
                selectedMetric={selectedMetric}
                height={chartHeight}
              />
            </div>
          )}
      </div>
    </div>
  );
};

export default TokenPage;
