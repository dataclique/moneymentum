import * as React from "react";
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
import type { TradingData } from "./types";
import { transformToLineData, transformToOHLC } from "./utils";

// Chart Component using TradingView Lightweight Charts
interface ChartComponentProps {
  data: TradingData[];
  selectedMetric: string;
  timeframe: string;
}

const ChartComponent: React.FC<ChartComponentProps> = (
  { data, selectedMetric, timeframe },
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
          background: { type: ColorType.Solid, color: "#000" },
          textColor: "#fff",
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
          secondsVisible: timeframe === "15m",
        },
        width: chartContainerRef.current.clientWidth,
        height: chartContainerRef.current.clientHeight,
      });

      chartRef.current = chart;

      // Handle resize
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          chart.applyOptions({ width, height });
        }
      });

      resizeObserver.observe(chartContainerRef.current);

      return () => {
        resizeObserver.disconnect();

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
  }, []);

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
          time: (item.date.getTime() / 1000) as any, // Convert to UNIX timestamp
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
            time: (item.date.getTime() / 1000) as any,
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

        const chartData = lineData.map((d) => ({
          time: (new Date(d.time).getTime() / 1000) as any,
          value: d.value,
        }));

        lineSeries.setData(chartData);
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
  }, [data, selectedMetric, timeframe]);

  return (
    <div
      ref={chartContainerRef}
      style={{
        width: "100%",
        height: "100%",
      }}
    />
  );
};

export default ChartComponent;
