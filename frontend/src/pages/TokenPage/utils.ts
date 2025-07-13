import type { IOHLCData, TradingData } from "./types";

// Transform trading data to OHLC format for price chart
export const transformToOHLC = (data: TradingData[]): IOHLCData[] => {
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
export const transformToLineData = (
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