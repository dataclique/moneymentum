import * as React from "react";
import { Link, useParams } from "react-router-dom";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AVAILABLE_METRICS } from "./constants";
import ChartComponent from "./ChartComponent";
import type { TradingData } from "./types";

// Main TokenPage component
const TokenPage: React.FC = () => {
  const { ticker } = useParams<{ ticker: string }>();
  const [data, setData] = React.useState<TradingData[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = React.useState("price");

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

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Loading...</CardTitle>
          </CardHeader>
          <CardContent>
            <p>Loading data for {ticker}...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Card className="w-full max-w-sm border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{error}</p>
            <Button asChild variant="link" className="p-0 mt-4 h-auto">
              <Link to="/">
                ← Back to Main Page
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Card className="w-screen h-screen rounded-none border-none px-[2%] pt-[10px] flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Button asChild variant="ghost">
              <Link to="/">
                ←&nbsp;Back
              </Link>
            </Button>
            <CardTitle className="text-2xl font-bold">
              {ticker} - {selectedMetricLabel}
            </CardTitle>
          </div>
          <div className="w-48">
            <Select value={selectedMetric} onValueChange={setSelectedMetric}>
              <SelectTrigger>
                <SelectValue placeholder="Select a metric" />
              </SelectTrigger>
              <SelectContent>
                {AVAILABLE_METRICS.map((metric) => (
                  <SelectItem key={metric.value} value={metric.value}>
                    {metric.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-1">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            No data available for {selectedMetricLabel}
          </div>
        ) : (
          <ChartComponent data={data} selectedMetric={selectedMetric} />
        )}
      </CardContent>
    </Card>
  );
};

export default TokenPage;
