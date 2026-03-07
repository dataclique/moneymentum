import { splitProps } from "solid-js"
import { useTheme } from "@/hooks/useTheme"
import { Toaster as Sonner, type ToasterProps } from "solid-sonner"

const Toaster = (props: ToasterProps) => {
  const { theme } = useTheme()

  const [, rest] = splitProps(props, ["theme", "class", "toastOptions"])

  return (
    <Sonner
      theme={theme() as "light" | "dark" | "system"}
      class="toaster group"
      toastOptions={{
        classes: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
        ...props.toastOptions,
      }}
      {...rest}
    />
  )
}

export { Toaster }
