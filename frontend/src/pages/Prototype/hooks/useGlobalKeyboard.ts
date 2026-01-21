import { useEffect, type DependencyList } from "react"
import { createKeyboardHandler, type KeyBinding } from "../utils/keyboard"

const useGlobalKeyboard = (
  bindings: KeyBinding[],
  deps: DependencyList,
  options?: {
    ignoreInputs?: boolean
  },
) => {
  // useEffect justified: Global keyboard shortcuts must listen on window/document
  // since they work regardless of which element has focus. Cannot use component-level onKeyDown.
  useEffect(() => {
    const ignoreInputs = options?.ignoreInputs !== false

    const handler = (event: KeyboardEvent) => {
      if (ignoreInputs) {
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        ) {
          return
        }
      }
      createKeyboardHandler(bindings)(event)
    }

    window.addEventListener("keydown", handler)
    return () => {
      window.removeEventListener("keydown", handler)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export { useGlobalKeyboard }
