type KeyBinding = {
  key: string
  handler: () => void
  when?: () => boolean
  preventDefault?: boolean
  stopImmediatePropagation?: boolean
}

const createKeyboardHandler =
  (bindings: KeyBinding[]) => (event: KeyboardEvent) => {
    const binding = bindings.find(
      binding =>
        binding.key === event.key &&
        (binding.when === undefined || binding.when()),
    )
    if (binding) {
      if (binding.preventDefault !== false) {
        event.preventDefault()
      }
      if (binding.stopImmediatePropagation) {
        event.stopImmediatePropagation()
      }
      binding.handler()
    }
  }

export type { KeyBinding }
export { createKeyboardHandler }
