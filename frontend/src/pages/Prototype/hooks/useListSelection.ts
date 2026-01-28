import { useState, useCallback, useMemo } from "react"

export type ListPanelId = "screener" | "positions"

interface ScreenerItem {
  symbol: string
}

interface InstrumentItem {
  symbol: string
}

interface PositionItem {
  underlying: string
  instruments: InstrumentItem[]
}

interface UseListSelectionConfig {
  screenerItems: ScreenerItem[]
  positionItems: PositionItem[]
  onAddTrade: (symbol: string, side: "buy" | "sell") => void
  onAdjustWeight?: (symbol: string, delta: number) => void
}

interface SelectionState {
  screener: number | null
  positions: number | null
  instrumentIndex: number | null // Index within expanded underlying's instruments
}

const clampIndex = (index: number | null, length: number): number | null => {
  if (index === null || length === 0) return length === 0 ? null : index
  if (length === 0) return null
  return Math.min(index, length - 1)
}

export const useListSelection = (config: UseListSelectionConfig) => {
  const { screenerItems, positionItems, onAddTrade, onAdjustWeight } = config

  const [focusedPanel, setFocusedPanel] = useState<ListPanelId | null>(null)
  const [rawSelection, setRawSelection] = useState<SelectionState>({
    screener: null,
    positions: null,
    instrumentIndex: null,
  })
  // Initialize with multi-instrument positions expanded (matches UI default)
  const [expandedUnderlyings, setExpandedUnderlyings] = useState<Set<string>>(
    () =>
      new Set(
        positionItems
          .filter(p => p.instruments.length > 1)
          .map(p => p.underlying),
      ),
  )

  // Derive clamped selection during render (no useEffect needed)
  const selection = useMemo((): SelectionState => {
    const clampedPositions = clampIndex(
      rawSelection.positions,
      positionItems.length,
    )

    // Clamp instrument index based on selected position's instruments
    let clampedInstrumentIndex: number | null = null
    if (clampedPositions !== null && rawSelection.instrumentIndex !== null) {
      const selectedPosition = positionItems[clampedPositions]
      if (expandedUnderlyings.has(selectedPosition.underlying)) {
        clampedInstrumentIndex = clampIndex(
          rawSelection.instrumentIndex,
          selectedPosition.instruments.length,
        )
      }
    }

    return {
      screener: clampIndex(rawSelection.screener, screenerItems.length),
      positions: clampedPositions,
      instrumentIndex: clampedInstrumentIndex,
    }
  }, [rawSelection, screenerItems.length, positionItems, expandedUnderlyings])

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

  // Check if we're at the boundary of the list (can't move further in direction)
  const isAtBoundary = useCallback(
    (direction: "up" | "down"): boolean => {
      if (focusedPanel === null) return false

      const length = getListLength(focusedPanel)
      if (length === 0) return true

      const current = selection[focusedPanel]
      if (current === null) return false

      if (focusedPanel === "positions") {
        const selectedPosition = positionItems[current]
        const isPositionExpanded = expandedUnderlyings.has(
          selectedPosition.underlying,
        )

        if (direction === "down") {
          // At boundary if: at last underlying AND (not expanded OR at last instrument)
          const isLastUnderlying = current >= length - 1
          if (!isLastUnderlying) return false

          if (isPositionExpanded) {
            const instrumentCount = selectedPosition.instruments.length
            const atLastInstrument =
              selection.instrumentIndex !== null &&
              selection.instrumentIndex >= instrumentCount - 1
            return atLastInstrument
          }
          return true
        } else {
          // At boundary if: at first underlying AND at underlying level (not in instruments)
          return current === 0 && selection.instrumentIndex === null
        }
      }

      // For screener panel
      if (direction === "down") {
        return current >= length - 1
      } else {
        return current === 0
      }
    },
    [
      focusedPanel,
      getListLength,
      selection,
      positionItems,
      expandedUnderlyings,
    ],
  )

  const moveSelection = useCallback(
    (direction: "up" | "down"): "moved" | "boundary" => {
      if (focusedPanel === null) return "boundary"

      const length = getListLength(focusedPanel)
      if (length === 0) return "boundary"

      // Check if at boundary before moving
      if (isAtBoundary(direction)) {
        return "boundary"
      }

      setRawSelection(prev => {
        const current = prev[focusedPanel]

        // Handle nested navigation for positions panel
        if (focusedPanel === "positions" && current !== null) {
          const selectedPosition = positionItems[current]
          const isExpanded = expandedUnderlyings.has(
            selectedPosition.underlying,
          )

          if (isExpanded) {
            const instrumentCount = selectedPosition.instruments.length

            if (direction === "down") {
              // If at underlying level, move to first instrument
              if (prev.instrumentIndex === null) {
                return { ...prev, instrumentIndex: 0 }
              }
              // If at last instrument, move to next underlying
              if (prev.instrumentIndex >= instrumentCount - 1) {
                const nextIndex = Math.min(current + 1, length - 1)
                return { ...prev, positions: nextIndex, instrumentIndex: null }
              }
              // Move to next instrument
              return { ...prev, instrumentIndex: prev.instrumentIndex + 1 }
            } else {
              // direction === "up"
              // If at first instrument, move back to underlying level
              if (prev.instrumentIndex === 0) {
                return { ...prev, instrumentIndex: null }
              }
              // If at underlying level with instruments, move to previous underlying
              if (prev.instrumentIndex === null) {
                const prevIndex = Math.max(current - 1, 0)
                return { ...prev, positions: prevIndex }
              }
              // Move to previous instrument
              return { ...prev, instrumentIndex: prev.instrumentIndex - 1 }
            }
          }
        }

        // Standard flat navigation
        let newIndex: number
        if (current === null) {
          newIndex = 0
        } else if (direction === "down") {
          newIndex = Math.min(current + 1, length - 1)
        } else {
          newIndex = Math.max(current - 1, 0)
        }

        return { ...prev, [focusedPanel]: newIndex, instrumentIndex: null }
      })

      return "moved"
    },
    [
      focusedPanel,
      getListLength,
      positionItems,
      expandedUnderlyings,
      isAtBoundary,
    ],
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

  const getSelectedInstrument = useCallback((): string | null => {
    if (focusedPanel !== "positions") return null

    const posIndex = selection.positions
    if (posIndex === null || selection.instrumentIndex === null) return null

    const position = positionItems[posIndex]
    return position.instruments[selection.instrumentIndex]?.symbol ?? null
  }, [focusedPanel, selection, positionItems])

  const isExpanded = useCallback(
    (underlying: string): boolean => {
      return expandedUnderlyings.has(underlying)
    },
    [expandedUnderlyings],
  )

  const toggleExpand = useCallback(() => {
    if (focusedPanel !== "positions") return

    const posIndex = selection.positions
    if (posIndex === null) return

    const position = positionItems[posIndex]
    const underlying = position.underlying
    const isCurrentlyExpanded = expandedUnderlyings.has(underlying)

    if (isCurrentlyExpanded) {
      setExpandedUnderlyings(
        prev => new Set([...prev].filter(u => u !== underlying)),
      )
      setRawSelection(s => ({ ...s, instrumentIndex: null }))
    } else {
      setExpandedUnderlyings(prev => new Set([...prev, underlying]))
    }
  }, [focusedPanel, selection.positions, positionItems, expandedUnderlyings])

  const adjustWeight = useCallback(
    (delta: number) => {
      if (!onAdjustWeight) return
      if (focusedPanel !== "positions") return

      const instrumentSymbol = getSelectedInstrument()
      if (!instrumentSymbol) return

      onAdjustWeight(instrumentSymbol, delta)
    },
    [focusedPanel, getSelectedInstrument, onAdjustWeight],
  )

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
      getSelectedInstrument,
      isExpanded,
      toggleExpand,
      adjustWeight,
    }),
    [
      focusedPanel,
      focusPanel,
      getSelectedIndex,
      moveSelection,
      triggerTrade,
      handleEscape,
      getSelectedSymbol,
      getSelectedInstrument,
      isExpanded,
      toggleExpand,
      adjustWeight,
    ],
  )
}
