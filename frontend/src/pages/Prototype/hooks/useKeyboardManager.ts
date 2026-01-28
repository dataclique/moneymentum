import { useEffect, useMemo, useCallback, useRef } from "react"
import { createShortcutRegistry, createEscapeStack } from "../keyboard"
import type { ShortcutRegistry, EscapeStack, EscapeHandler } from "../keyboard"
import { getDirection } from "../utils/keys"

type FocusedPanel = "screener" | "positions" | null
type SecondaryFocus = "performance" | "staged" | "none"

interface KeyboardManagerConfig {
  focusedPanel: FocusedPanel
  secondaryFocus: SecondaryFocus
  showHelp: boolean
  columnConfigVisible: boolean
  isMetricSelectorOpen: boolean
  showFactorConfig: boolean
}

interface KeyboardManagerActions {
  focusPanel: (panel: FocusedPanel) => void
  setSecondaryFocus: (focus: SecondaryFocus) => void
  toggleHelp: () => void
  closeColumnConfig: () => void
  toggleColumnConfig: () => void
  setIsMetricSelectorOpen: (fn: (prev: boolean) => boolean) => void
  setShowFactorConfig: (fn: (prev: boolean) => boolean) => void
  handleEscape: () => void
  moveSelection: (direction: "up" | "down") => "boundary" | "moved"
  triggerTrade: (side: "buy" | "sell") => void
  toggleExpand: () => void
  adjustWeight: (delta: number) => void
  getSelectedSymbol: () => string | undefined
  getSelectedIndex: (panel: "screener" | "positions") => number | null
  toggleUnderlying: (underlying: string) => void
  toggleScreenerExpanded: (ticker: string) => void
  openAddPositionModal: (underlying: string) => void
  setLeverage: (fn: (prev: number) => number) => void
  executeStagedTrades: () => void
}

interface KeyboardManagerDeps {
  sortedAssets: Array<{ ticker: string }>
}

interface UseKeyboardManagerProps {
  config: KeyboardManagerConfig
  actions: KeyboardManagerActions
  deps: KeyboardManagerDeps
}

export interface KeyboardManager {
  registry: ShortcutRegistry
  escapeStack: EscapeStack
  registerEscapeHandler: (handler: EscapeHandler) => () => void
}

export const useKeyboardManager = ({
  config,
  actions,
  deps,
}: UseKeyboardManagerProps): KeyboardManager => {
  const registryRef = useRef<ShortcutRegistry>(createShortcutRegistry())
  const escapeStackRef = useRef<EscapeStack>(createEscapeStack())

  const registry = registryRef.current
  const escapeStack = escapeStackRef.current

  const registerEscapeHandler = useCallback(
    (handler: EscapeHandler): (() => void) => {
      return escapeStack.push(handler)
    },
    [escapeStack],
  )

  const blurLeverageControl = useCallback(() => {
    document
      .querySelector<HTMLElement>('[data-testid="leverage-control"]')
      ?.blur()
  }, [])

  const focusLeverageControl = useCallback(() => {
    document
      .querySelector<HTMLElement>('[data-testid="leverage-control"]')
      ?.focus()
  }, [])

  // useEffect justified: Global keyboard shortcuts must listen on window/document
  // since they work regardless of which element has focus. Cannot use component-level onKeyDown.
  useEffect(() => {
    const { focusedPanel, secondaryFocus, showHelp, columnConfigVisible } =
      config
    const {
      focusPanel,
      setSecondaryFocus,
      toggleHelp,
      closeColumnConfig,
      toggleColumnConfig,
      setIsMetricSelectorOpen,
      setShowFactorConfig,
      handleEscape,
      moveSelection,
      triggerTrade,
      toggleExpand,
      adjustWeight,
      getSelectedSymbol,
      getSelectedIndex,
      toggleUnderlying,
      toggleScreenerExpanded,
      openAddPositionModal,
      setLeverage,
      executeStagedTrades,
    } = actions
    const { sortedAssets } = deps

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const key = event.key.toLowerCase()

      // Help toggle
      if (key === "?" || (event.key === "F1" && !event.ctrlKey)) {
        event.preventDefault()
        toggleHelp()
        return
      }

      // Escape handling via stack
      if (key === "escape") {
        event.preventDefault()
        if (showHelp) {
          toggleHelp()
        } else if (columnConfigVisible) {
          closeColumnConfig()
        } else if (secondaryFocus !== "none") {
          setSecondaryFocus("none")
        } else {
          handleEscape()
        }
        return
      }

      // Number keys for direct panel access
      if (event.key === "1") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (secondaryFocus === "staged") blurLeverageControl()
        setSecondaryFocus("none")
        focusPanel("screener")
        return
      }
      if (event.key === "2") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (secondaryFocus === "staged") blurLeverageControl()
        setSecondaryFocus("none")
        focusPanel("positions")
        return
      }
      if (event.key === "3") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (secondaryFocus === "staged") blurLeverageControl()
        focusPanel(null)
        setSecondaryFocus("performance")
        return
      }
      if (event.key === "4") {
        event.preventDefault()
        event.stopImmediatePropagation()
        focusPanel(null)
        setSecondaryFocus("staged")
        focusLeverageControl()
        return
      }

      // Navigation using vim keys (h/j/k/l) or arrow keys
      const direction = getDirection(event.key)

      // Horizontal: switch between panels (h/l or left/right arrows)
      if (focusedPanel && direction === "left") {
        event.preventDefault()
        focusPanel("screener")
        return
      }
      if (focusedPanel && direction === "right") {
        event.preventDefault()
        focusPanel("positions")
        return
      }

      // Vertical: navigate within lists (j/k or up/down arrows)
      if (focusedPanel && direction === "down") {
        event.preventDefault()
        const result = moveSelection("down")
        if (result === "boundary" && focusedPanel === "positions") {
          focusPanel(null)
          setSecondaryFocus("staged")
          focusLeverageControl()
        }
        return
      }
      if (focusedPanel && direction === "up") {
        event.preventDefault()
        moveSelection("up")
        return
      }

      // Navigate from staged changes back to positions with up
      if (secondaryFocus === "staged" && direction === "up") {
        event.preventDefault()
        blurLeverageControl()
        setSecondaryFocus("none")
        focusPanel("positions")
        return
      }

      // o, Space, or Enter to toggle expand/collapse in positions panel
      if (
        focusedPanel === "positions" &&
        (key === "o" || key === " " || key === "enter")
      ) {
        event.preventDefault()
        const selectedUnderlying = getSelectedSymbol()
        if (selectedUnderlying) {
          toggleUnderlying(selectedUnderlying)
        }
        toggleExpand()
        return
      }
      if (focusedPanel === "screener" && key === "o") {
        event.preventDefault()
        const selectedIdx = getSelectedIndex("screener")
        if (selectedIdx !== null) {
          const asset = sortedAssets[selectedIdx] as
            | { ticker: string }
            | undefined
          if (asset) {
            toggleScreenerExpanded(asset.ticker)
          }
        }
        return
      }

      // Enter to open add position modal from screener
      if (focusedPanel === "screener" && event.key === "Enter") {
        event.preventDefault()
        const selectedIdx = getSelectedIndex("screener")
        if (selectedIdx !== null) {
          const asset = sortedAssets[selectedIdx] as
            | { ticker: string }
            | undefined
          if (asset) {
            openAddPositionModal(asset.ticker)
          }
        }
        return
      }

      // +/- to stage trades (without shift) or adjust weight (with shift)
      if (focusedPanel && (key === "+" || key === "=")) {
        event.preventDefault()
        if (event.shiftKey) {
          adjustWeight(0.05)
        } else {
          triggerTrade("buy")
        }
        return
      }
      if (focusedPanel && key === "-") {
        event.preventDefault()
        if (event.shiftKey) {
          adjustWeight(-0.05)
        } else {
          triggerTrade("sell")
        }
        return
      }

      // m to open metric selector
      if (key === "m") {
        event.preventDefault()
        setIsMetricSelectorOpen(prev => !prev)
        return
      }

      // f to toggle factor config panel
      if (key === "f") {
        event.preventDefault()
        setShowFactorConfig(prev => !prev)
        return
      }

      // c to toggle screener column config
      if (key === "c") {
        event.preventDefault()
        toggleColumnConfig()
        return
      }

      // [ and ] for global leverage adjustment
      if (event.key === "[") {
        event.preventDefault()
        setLeverage(prev => Math.max(0.1, Math.round((prev - 0.1) * 10) / 10))
        return
      }
      if (event.key === "]") {
        event.preventDefault()
        setLeverage(prev => Math.min(5, Math.round((prev + 0.1) * 10) / 10))
        return
      }

      // x to execute staged trades
      if (key === "x") {
        event.preventDefault()
        executeStagedTrades()
        return
      }

      // Start navigation from screener if nothing focused
      if (!focusedPanel && ["h", "j", "k", "l"].includes(key)) {
        event.preventDefault()
        focusPanel("screener")
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [config, actions, deps, blurLeverageControl, focusLeverageControl])

  return useMemo(
    () => ({ registry, escapeStack, registerEscapeHandler }),
    [registry, escapeStack, registerEscapeHandler],
  )
}
