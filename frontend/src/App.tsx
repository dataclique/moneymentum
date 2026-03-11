import { ErrorBoundary } from "solid-js"
import type { RouteSectionProps } from "@solidjs/router"

const ErrorFallback = (props: { error: Error; reset: () => void }) => (
  <div class="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
    <div class="text-destructive text-lg font-medium">Something went wrong</div>
    <div class="text-sm text-muted-foreground max-w-md text-center">
      An unexpected error occurred. Try refreshing the page or click retry.
    </div>
    <pre class="text-xs text-muted-foreground bg-muted rounded p-3 max-w-lg overflow-auto">
      {props.error.message}
    </pre>
    <button
      type="button"
      onClick={() => {
        props.reset()
      }}
      class="rounded-md border px-4 py-2 text-sm hover:bg-muted transition-colors"
    >
      Retry
    </button>
  </div>
)

const renderFallback = (error: Error, reset: () => void) => (
  <ErrorFallback error={error} reset={reset} />
)

export const AppLayout = (props: RouteSectionProps) => {
  return (
    <ErrorBoundary fallback={renderFallback}>
      <div class="flex h-screen flex-col overflow-hidden bg-background text-foreground text-[11px]">
        {props.children}
      </div>
    </ErrorBoundary>
  )
}

export const FullscreenLayout = (props: RouteSectionProps) => {
  return (
    <ErrorBoundary fallback={renderFallback}>{props.children}</ErrorBoundary>
  )
}
