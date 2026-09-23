import { screen } from "@solidjs/testing-library"
import type { ParentProps } from "solid-js"
import { afterEach, expect, it, vi } from "vitest"

const mountedApplication = vi.hoisted(() => {
  const lifecycle: { dispose?: () => void } = {}
  return lifecycle
})

// Keep the real entrypoint and router; replace unrelated page/layout contents.
vi.mock("./App", () => {
  const layout = (props: ParentProps) => <>{props.children}</>
  return { AppLayout: layout, FullscreenLayout: layout }
})
vi.mock("./pages/TokenPage", () => ({
  default: (props: { timeframe?: string }) => (
    <div data-testid="token-timeframe">{props.timeframe ?? "missing"}</div>
  ),
}))

// Capture disposal without replacing Solid's rendering behavior.
vi.mock("solid-js/web", async importOriginal => {
  const web = await importOriginal<typeof import("solid-js/web")>()
  return {
    ...web,
    render: (...args: Parameters<typeof web.render>) => {
      const dispose = web.render(...args)
      mountedApplication.dispose = dispose
      return dispose
    },
  }
})

let root: HTMLDivElement | undefined

afterEach(() => {
  mountedApplication.dispose?.()
  root?.remove()
  vi.restoreAllMocks()
})

it("opens the token route with the configured 1h timeframe", async () => {
  window.history.replaceState({}, "", "/token/BTC")
  root = document.createElement("div")
  root.id = "root"
  document.body.append(root)

  await import("./main")

  expect(await screen.findByTestId("token-timeframe")).toHaveTextContent(/^1h$/)
})
