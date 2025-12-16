import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useNetwork } from "./useNetwork"
import { NetworkProvider } from "@/contexts/NetworkContext"
import type { ReactNode } from "react"

const createWrapper = () => {
  return ({ children }: { children: ReactNode }) => (
    <NetworkProvider>{children}</NetworkProvider>
  )
}

describe("useNetwork", () => {
  it("throws error when used outside NetworkProvider", () => {
    expect(() => {
      renderHook(() => useNetwork())
    }).toThrow("useNetwork must be used within a NetworkProvider")
  })

  it("returns isNetworkSwitching as false initially", () => {
    const { result } = renderHook(() => useNetwork(), {
      wrapper: createWrapper(),
    })

    expect(result.current.isNetworkSwitching).toBe(false)
  })

  it("provides setIsNetworkSwitching function", () => {
    const { result } = renderHook(() => useNetwork(), {
      wrapper: createWrapper(),
    })

    expect(typeof result.current.setIsNetworkSwitching).toBe("function")
  })

  it("updates isNetworkSwitching when setIsNetworkSwitching is called", () => {
    const { result } = renderHook(() => useNetwork(), {
      wrapper: createWrapper(),
    })

    expect(result.current.isNetworkSwitching).toBe(false)

    act(() => {
      result.current.setIsNetworkSwitching(true)
    })

    expect(result.current.isNetworkSwitching).toBe(true)

    act(() => {
      result.current.setIsNetworkSwitching(false)
    })

    expect(result.current.isNetworkSwitching).toBe(false)
  })
})
