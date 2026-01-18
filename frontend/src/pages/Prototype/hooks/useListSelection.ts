import { useState, useCallback, useMemo } from "react"

export type ListPanelId = "screener" | "positions"

interface ScreenerItem {
  symbol: string
}

interface PositionItem {
  underlying: string
}

interface UseListSelectionConfig {
  screenerItems: ScreenerItem[]
  positionItems: PositionItem[]
  onAddTrade: (symbol: string, side: "buy" | "sell") => void
}

interface SelectionState {
  screener: number | null
  positions: number | null
}

const clampIndex = (index: number | null, length: number): number | null => {
  if (index === null || length === 0) return length === 0 ? null : index
  if (length === 0) return null
  return Math.min(index, length - 1)
}

export const useListSelection = (config: UseListSelectionConfig) => {
  const { screenerItems, positionItems, onAddTrade } = config

  const [focusedPanel, setFocusedPanel] = useState<ListPanelId | null>(null)
  const [rawSelection, setRawSelection] = useState<SelectionState>({
    screener: null,
    positions: null,
  })

  // Derive clamped selection during render (no useEffect needed)
  const selection = useMemo(
    (): SelectionState => ({
      screener: clampIndex(rawSelection.screener, screenerItems.length),
      positions: clampIndex(rawSelection.positions, positionItems.length),
    }),
    [rawSelection, screenerItems.length, positionItems.length],
  )

  const getListLength = useCallback(
    (panel: ListPanelId): number => {
      return panel === "screener" ? screenerItems.length : positionItems.length
    },
    [screenerItems.length, positionItems.length],
  )

  const focusPanel = useCallback(
    (panel: ListPanelId | null) => {
      setFocusedPanel(panel)

      if (panel !== null) {
        setRawSelection(prev => {
          // If already has selection for this panel, keep it
          if (prev[panel] !== null) return prev

          // Otherwise select first item if list is not empty
          const length =
            panel === "screener" ? screenerItems.length : positionItems.length
          if (length === 0) return prev

          return { ...prev, [panel]: 0 }
        })
      }
    },
    [screenerItems.length, positionItems.length],
  )

  const getSelectedIndex = useCallback(
    (panel: ListPanelId): number | null => {
      return selection[panel]
    },
    [selection],
  )

  const moveSelection = useCallback(
    (direction: "up" | "down") => {
      if (focusedPanel === null) return

      const length = getListLength(focusedPanel)
      if (length === 0) return

      setRawSelection(prev => {
        const current = prev[focusedPanel]
        let newIndex: number

        if (current === null) {
          newIndex = 0
        } else if (direction === "down") {
          newIndex = Math.min(current + 1, length - 1)
        } else {
          newIndex = Math.max(current - 1, 0)
        }

        return { ...prev, [focusedPanel]: newIndex }
      })
    },
    [focusedPanel, getListLength],
  )

  const getSelectedSymbol = useCallback((): string | null => {
    if (focusedPanel === null) return null

    const index = selection[focusedPanel]
    if (index === null) return null

    if (focusedPanel === "screener") {
      return screenerItems[index]?.symbol ?? null
    } else {
      return positionItems[index]?.underlying ?? null
    }
  }, [focusedPanel, selection, screenerItems, positionItems])

  const triggerTrade = useCallback(
    (side: "buy" | "sell") => {
      const symbol = getSelectedSymbol()
      if (symbol === null) return

      onAddTrade(symbol, side)
    },
    [getSelectedSymbol, onAddTrade],
  )

  const handleEscape = useCallback(() => {
    if (focusedPanel === null) return

    const currentSelection = selection[focusedPanel]

    if (currentSelection !== null) {
      // First escape: clear selection
      setRawSelection(prev => ({ ...prev, [focusedPanel]: null }))
    } else {
      // Second escape: unfocus panel
      setFocusedPanel(null)
    }
  }, [focusedPanel, selection])

  return useMemo(
    () => ({
      focusedPanel,
      focusPanel,
      getSelectedIndex,
      moveSelection,
      triggerTrade,
      handleEscape,
      getSelectedSymbol,
    }),
    [
      focusedPanel,
      focusPanel,
      getSelectedIndex,
      moveSelection,
      triggerTrade,
      handleEscape,
      getSelectedSymbol,
    ],
  )
}
