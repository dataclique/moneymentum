import { X } from "lucide-react"

interface HelpOverlayProps {
  onClose: () => void
}

const ShortcutGroup = ({
  title,
  shortcuts,
}: {
  title: string
  shortcuts: Array<{ key: string; description: string }>
}) => (
  <div className="space-y-1">
    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
      {title}
    </div>
    {shortcuts.map(s => (
      <div key={s.key} className="flex items-center gap-2 text-sm">
        <kbd className="px-1.5 py-0.5 text-xs font-mono bg-muted rounded min-w-[24px] text-center">
          {s.key}
        </kbd>
        <span className="text-muted-foreground">{s.description}</span>
      </div>
    ))}
  </div>
)

export const HelpOverlay = ({ onClose }: HelpOverlayProps) => {
  return (
    <div className="fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-background border border-border rounded-lg shadow-lg max-w-2xl w-full mx-4 max-h-[80vh] overflow-auto">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <h2 className="text-sm font-medium">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 grid grid-cols-2 gap-6">
          <ShortcutGroup
            title="Panel Navigation"
            shortcuts={[
              { key: "1", description: "Screener" },
              { key: "2", description: "Positions" },
              { key: "Esc", description: "Unfocus / Close" },
              { key: "?", description: "Toggle this help" },
            ]}
          />
          <ShortcutGroup
            title="Vim Navigation"
            shortcuts={[
              { key: "h", description: "Move left" },
              { key: "j", description: "Move down" },
              { key: "k", description: "Move up" },
              { key: "l", description: "Move right" },
            ]}
          />
          <ShortcutGroup
            title="Analysis Tabs"
            shortcuts={[
              { key: "P", description: "Performance tab" },
              { key: "F", description: "Factors tab" },
              { key: "R", description: "Risk tab" },
            ]}
          />
          <ShortcutGroup
            title="Trading"
            shortcuts={[
              { key: "+", description: "Add long position (click)" },
              { key: "-", description: "Add short position (click)" },
            ]}
          />
        </div>
        <div className="p-3 border-t border-border bg-muted/30 text-xs text-muted-foreground">
          Press <kbd className="px-1 py-0.5 bg-muted rounded font-mono">?</kbd>{" "}
          or <kbd className="px-1 py-0.5 bg-muted rounded font-mono">Esc</kbd>{" "}
          to close
        </div>
      </div>
    </div>
  )
}
