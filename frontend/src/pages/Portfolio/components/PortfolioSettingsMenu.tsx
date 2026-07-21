import { For, type JSX } from "solid-js"
import { Settings } from "lucide-solid"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import {
  PORTFOLIO_METRIC_COLUMN_LABELS,
  PORTFOLIO_METRIC_COLUMN_ORDER,
  type PortfolioMetricColumnId,
  type PortfolioMetricVisibility,
} from "./PositionsPanel/portfolioMetricVisibility"

export interface PortfolioSettingsMenuProps {
  isPrecise: boolean
  onPreciseChange: (value: boolean) => void
  isManualWeightEntry: boolean
  onManualWeightEntryChange: (value: boolean) => void
  metricVisibility: PortfolioMetricVisibility
  onMetricVisibilityChange: (
    columnId: PortfolioMetricColumnId,
    visible: boolean,
  ) => void
}

export const PortfolioSettingsMenu = (
  props: PortfolioSettingsMenuProps,
): JSX.Element => (
  <DropdownMenu>
    <DropdownMenuTrigger
      as={Button}
      variant="ghost"
      size="icon"
      class="h-6 w-6"
      aria-label="Open positions settings"
      onPointerDown={(event: PointerEvent) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <Settings class="h-3.5 w-3.5" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem
        class="flex items-center justify-between gap-2"
        closeOnSelect={false}
      >
        <span>Precise</span>
        <Switch
          checked={props.isPrecise}
          onChange={value => {
            props.onPreciseChange(value)
          }}
        />
      </DropdownMenuItem>
      <DropdownMenuItem
        class="flex items-center justify-between gap-2"
        closeOnSelect={false}
      >
        <span>Manual weight entry</span>
        <Switch
          checked={props.isManualWeightEntry}
          onChange={value => {
            props.onManualWeightEntryChange(value)
          }}
        />
      </DropdownMenuItem>
      <For each={PORTFOLIO_METRIC_COLUMN_ORDER}>
        {columnId => (
          <DropdownMenuItem
            class="flex items-center justify-between gap-2"
            closeOnSelect={false}
          >
            <span>{PORTFOLIO_METRIC_COLUMN_LABELS[columnId]}</span>
            <Switch
              checked={props.metricVisibility[columnId]}
              onChange={value => {
                props.onMetricVisibilityChange(columnId, value)
              }}
            />
          </DropdownMenuItem>
        )}
      </For>
    </DropdownMenuContent>
  </DropdownMenu>
)
