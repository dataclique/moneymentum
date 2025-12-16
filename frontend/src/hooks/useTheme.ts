import { useContext } from "react"
import { ThemeProviderContext } from "@/contexts/theme-context"

export const useTheme = () => {
  return useContext(ThemeProviderContext)
}
