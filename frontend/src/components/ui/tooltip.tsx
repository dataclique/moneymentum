import type { Component, ValidComponent } from "solid-js"
import type { ParentProps } from "solid-js"

import type { PolymorphicProps } from "@kobalte/core/polymorphic"
import * as TooltipPrimitive from "@kobalte/core/tooltip"

import { cn } from "@/lib/cn"

const TooltipTrigger = TooltipPrimitive.Trigger

const Tooltip: Component<TooltipPrimitive.TooltipRootProps> = props => {
  return <TooltipPrimitive.Root gutter={4} {...props} />
}

const TooltipProvider = (props: ParentProps) => <>{props.children}</>

type TooltipContentProps<T extends ValidComponent = "div"> = PolymorphicProps<
  T,
  TooltipPrimitive.TooltipContentProps<T>
> & { class?: string | undefined }

const TooltipContent = <T extends ValidComponent = "div">(
  props: TooltipContentProps<T>,
) => {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content<T>
        {...props}
        class={cn(
          "z-50 origin-[var(--kb-tooltip-content-transform-origin)] overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          props.class,
        )}
      />
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
