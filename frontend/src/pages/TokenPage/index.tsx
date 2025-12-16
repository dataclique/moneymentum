import * as React from "react"
import { Link, useParams } from "react-router-dom"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useNetwork } from "@/hooks/useNetwork"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  TimeframeSelect,
  type Timeframe,
} from "@/components/ui/timeframe-select"
import { Button } from "@/components/ui/button"
import { AVAILABLE_METRICS } from "./constants"
import ChartComponent from "./ChartComponent"
import { useTokenData } from "@/hooks/useApi"

const TokenPage: React.FC<{ timeframe: Timeframe }> = ({
  timeframe: initialTimeframe,
}) => {
  const { ticker } = useParams<{ ticker: string }>()
  const [selectedMetric, setSelectedMetric] = React.useState("price")
  const [timeframe, setTimeframe] = React.useState<Timeframe>(initialTimeframe)
  const { isNetworkSwitching } = useNetwork()

  const { data: tokenData, error, isLoading } = useTokenData(ticker, timeframe)

  const data = tokenData?.data ?? []

  const selectedMetricLabel = React.useMemo(() => {
    return (
      AVAILABLE_METRICS.find(m => m.value === selectedMetric)?.label ??
      selectedMetric
    )
  }, [selectedMetric])

  if (isLoading) {
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
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Card className="w-full max-w-sm border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{error.message}</p>
            <Button asChild variant="link" className="p-0 mt-4 h-auto">
              <Link to="/">← Back to Main Page</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <Card
      className={cn(
        "w-screen h-screen rounded-none border-none px-[2%] pt-[10px] flex flex-col",
        isNetworkSwitching && "pointer-events-none opacity-50",
      )}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Button asChild variant="ghost">
              <Link to="/">←&nbsp;Back</Link>
            </Button>
            <CardTitle className="text-2xl font-bold">
              {ticker} - {selectedMetricLabel}
            </CardTitle>
          </div>
          <div className="flex items-center gap-4">
            <TimeframeSelect
              value={timeframe}
              onValueChange={setTimeframe}
              className="w-48"
            />
            <div className="w-48">
              <Select value={selectedMetric} onValueChange={setSelectedMetric}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a metric" />
                </SelectTrigger>
                <SelectContent>
                  {AVAILABLE_METRICS.map(metric => (
                    <SelectItem key={metric.value} value={metric.value}>
                      {metric.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-1">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            No data available for {selectedMetricLabel}
          </div>
        ) : (
          <ChartComponent
            data={data}
            selectedMetric={selectedMetric}
            timeframe={timeframe}
          />
        )}
      </CardContent>
    </Card>
  )
}

export default TokenPage
