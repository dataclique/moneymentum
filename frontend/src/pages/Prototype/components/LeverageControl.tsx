interface LeverageControlProps {
  leverage: number
  effectiveLeverage: number
  onLeverageChange: (value: number) => void
}

export const LeverageControl = ({
  leverage,
  effectiveLeverage,
  onLeverageChange,
}: LeverageControlProps) => {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/30">
      <span className="text-muted-foreground">Leverage</span>
      <input
        type="range"
        min="0.1"
        max="5"
        step="0.1"
        value={leverage}
        onChange={e => {
          onLeverageChange(parseFloat(e.target.value))
        }}
        className="flex-1 h-1 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
      />
      <span className="font-mono w-12 text-right">
        {effectiveLeverage.toFixed(2)}x
      </span>
    </div>
  )
}
