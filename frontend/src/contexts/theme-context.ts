import { createContext } from "react"

type Theme = "dark" | "light" | "system"

export type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const ThemeProviderContext = createContext<
  ThemeProviderState | undefined
>(undefined)
