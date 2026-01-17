import { useState, useCallback, useEffect } from "react"

export type PanelId =
  | "positions"
  | "screener"
  | "factors"
  | "greeks"
  | "staged"
  | "correlation"
  | "decomposition"
  | "targets"
  | "risk"
  | "chart"
  | "montecarlo"
  | "performance"
  | "stress"

interface PanelPosition {
  row: number
  col: number
}

// Grid layout for navigation (row, col)
const PANEL_GRID: Record<PanelId, PanelPosition> = {
  positions: { row: 0, col: 0 },
  factors: { row: 0, col: 1 },
  greeks: { row: 0, col: 2 },
  staged: { row: 0, col: 3 },
  screener: { row: 1, col: 0 },
  decomposition: { row: 1, col: 1 },
  correlation: { row: 1, col: 2 },
  targets: { row: 1, col: 3 },
  chart: { row: 2, col: 0 },
  montecarlo: { row: 2, col: 1 },
  performance: { row: 2, col: 2 },
  stress: { row: 2, col: 3 },
  risk: { row: 3, col: 3 },
}

const PANEL_IDS = Object.keys(PANEL_GRID) as PanelId[]

// Bloomberg-style shortcuts: number keys 1-9, 0 for 10th panel
const NUMBER_TO_PANEL: Record<string, PanelId> = {
  "1": "positions",
  "2": "factors",
  "3": "greeks",
  "4": "staged",
  "5": "screener",
  "6": "decomposition",
  "7": "correlation",
  "8": "targets",
  "9": "chart",
  "0": "montecarlo",
}

export interface KeyboardNavigationState {
  focusedPanel: PanelId | null
  expandedPanel: PanelId | null
  showHelp: boolean
}

export const useKeyboardNavigation = () => {
  const [state, setState] = useState<KeyboardNavigationState>({
    focusedPanel: null,
    expandedPanel: null,
    showHelp: false,
  })

  const focusPanel = useCallback((panelId: PanelId | null) => {
    setState(prev => ({ ...prev, focusedPanel: panelId }))
  }, [])

  const toggleExpand = useCallback((panelId: PanelId) => {
    setState(prev => ({
      ...prev,
      expandedPanel: prev.expandedPanel === panelId ? null : panelId,
    }))
  }, [])

  const collapseExpanded = useCallback(() => {
    setState(prev => ({ ...prev, expandedPanel: null }))
  }, [])

  const toggleHelp = useCallback(() => {
    setState(prev => ({ ...prev, showHelp: !prev.showHelp }))
  }, [])

  const findPanelInDirection = useCallback(
    (
      from: PanelId,
      direction: "up" | "down" | "left" | "right",
    ): PanelId | null => {
      const current = PANEL_GRID[from]
      let targetRow = current.row
      let targetCol = current.col

      switch (direction) {
        case "up":
          targetRow--
          break
        case "down":
          targetRow++
          break
        case "left":
          targetCol--
          break
        case "right":
          targetCol++
          break
      }

      // Find panel at target position (or closest)
      const candidates = PANEL_IDS.filter(id => {
        const pos = PANEL_GRID[id]
        if (direction === "up" || direction === "down") {
          return pos.row === targetRow
        }
        return pos.col === targetCol
      })

      if (candidates.length === 0) return null

      // Find closest match
      return candidates.reduce((closest, id) => {
        const pos = PANEL_GRID[id]
        const closestPos = PANEL_GRID[closest]
        const currentDist =
          Math.abs(pos.row - current.row) + Math.abs(pos.col - current.col)
        const closestDist =
          Math.abs(closestPos.row - current.row) +
          Math.abs(closestPos.col - current.col)
        return currentDist < closestDist ? id : closest
      })
    },
    [],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle if typing in an input
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const key = event.key.toLowerCase()

      // ? for help (Bloomberg: F1, vim: ?)
      if (key === "?" || (event.key === "F1" && !event.ctrlKey)) {
        event.preventDefault()
        toggleHelp()
        return
      }

      // Escape to close help, collapse expanded, or unfocus
      if (key === "escape") {
        event.preventDefault()
        if (state.showHelp) {
          setState(prev => ({ ...prev, showHelp: false }))
        } else if (state.expandedPanel) {
          collapseExpanded()
        } else {
          focusPanel(null)
        }
        return
      }

      // Number keys for direct panel access (Bloomberg style)
      if (event.key in NUMBER_TO_PANEL) {
        event.preventDefault()
        const targetPanel = NUMBER_TO_PANEL[event.key]
        focusPanel(targetPanel)
        return
      }

      // Enter or f to expand focused panel (Bloomberg: <GO>, vim: f for fullscreen)
      if ((key === "enter" || key === "f") && state.focusedPanel) {
        event.preventDefault()
        toggleExpand(state.focusedPanel)
        return
      }

      // Vim-style navigation: h/j/k/l
      if (state.focusedPanel && ["h", "j", "k", "l"].includes(key)) {
        event.preventDefault()
        const directionMap: Record<string, "up" | "down" | "left" | "right"> = {
          h: "left",
          j: "down",
          k: "up",
          l: "right",
        }
        const nextPanel = findPanelInDirection(
          state.focusedPanel,
          directionMap[key],
        )
        if (nextPanel) focusPanel(nextPanel)
        return
      }

      // Arrow keys for navigation (Bloomberg style)
      if (state.focusedPanel && event.key.startsWith("Arrow")) {
        event.preventDefault()
        const directionMap: Record<string, "up" | "down" | "left" | "right"> = {
          ArrowUp: "up",
          ArrowDown: "down",
          ArrowLeft: "left",
          ArrowRight: "right",
        }
        const nextPanel = findPanelInDirection(
          state.focusedPanel,
          directionMap[event.key],
        )
        if (nextPanel) focusPanel(nextPanel)
        return
      }

      // If no panel focused, start with positions on any navigation key
      if (!state.focusedPanel && ["h", "j", "k", "l"].includes(key)) {
        event.preventDefault()
        focusPanel("positions")
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [
    state.focusedPanel,
    state.expandedPanel,
    state.showHelp,
    focusPanel,
    toggleExpand,
    collapseExpanded,
    toggleHelp,
    findPanelInDirection,
  ])

  return {
    ...state,
    focusPanel,
    toggleExpand,
    collapseExpanded,
    toggleHelp,
  }
}
