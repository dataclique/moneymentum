import { useParams } from "react-router-dom";
import { useEffect, useState } from "react";
// Для графика используем Chart.js (или можно заменить на другой)
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import type { TradingData } from "./ui/columns";
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const METRICS = [
  { key: "close", label: "Close Price" },
  { key: "volume", label: "Volume" },
  { key: "log_return", label: "Log Return" },
  { key: "cum_return", label: "Cumulative Return" },
  { key: "sharpe", label: "Sharpe Ratio" },
  { key: "sortino", label: "Sortino Ratio" },
  { key: "beta", label: "Beta" },
  { key: "annualized_volatility", label: "Annualized Volatility" },
] as const;
type MetricKey = typeof METRICS[number]["key"];

export default function TokenPage() {
  const { ticker } = useParams<{ ticker: string }>();
  const [metric, setMetric] = useState<MetricKey>(METRICS[0].key);
  const [data, setData] = useState<TradingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("http://localhost:8000/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    })
      .then((res) => res.json())
      .then((res) => {
        setData(res.data || []);
        setLoading(false);
      })
      .catch(() => {
        setError("Ошибка загрузки данных");
        setLoading(false);
      });
  }, [ticker]);

  if (loading) return <div className="p-8 text-center">Загрузка...</div>;
  if (error) return <div className="p-8 text-center text-red-400">{error}</div>;

  const chartData = {
    labels: data.map((d) => d.timestamp),
    datasets: [
      {
        label: METRICS.find((m) => m.key === metric)?.label,
        data: data.map((d) => d[metric] as number | null),
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,0.2)",
      },
    ],
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-8">
      <h1 className="text-2xl font-bold mb-4">Токен: {ticker}</h1>
      <div className="mb-4">
        <label className="mr-2">Метрика:</label>
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as MetricKey)}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
        >
          {METRICS.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
      </div>
      <div className="bg-gray-800 p-4 rounded shadow">
        <Line data={chartData} />
      </div>
    </div>
  );
} 