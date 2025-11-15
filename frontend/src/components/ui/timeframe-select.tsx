import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

export type Timeframe = "1h" | "15m"

const TIMEFRAME_OPTIONS = [
  { value: "1h", label: "1 hour" },
  { value: "15m", label: "15 minutes" },
] as const satisfies readonly { value: Timeframe; label: string }[]

interface TimeframeSelectProps {
  value: Timeframe
  onValueChange: (value: Timeframe) => void
  className?: string
}

export function TimeframeSelect({
  value,
  onValueChange,
  className,
}: TimeframeSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder="Select timeframe" />
      </SelectTrigger>
      <SelectContent>
        {TIMEFRAME_OPTIONS.map(option => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
