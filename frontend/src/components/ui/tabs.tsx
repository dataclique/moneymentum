import type { ValidComponent } from "solid-js"

import type { PolymorphicProps } from "@kobalte/core/polymorphic"
import * as TabsPrimitive from "@kobalte/core/tabs"

import { cn } from "@/lib/cn"

const Tabs = TabsPrimitive.Root

type TabsListProps<T extends ValidComponent = "div"> = PolymorphicProps<
  T,
  TabsPrimitive.TabsListProps<T>
> & {
  class?: string | undefined
}

const TabsList = <T extends ValidComponent = "div">(
  props: TabsListProps<T>,
) => (
  <TabsPrimitive.List<T>
    {...props}
    class={cn(
      "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
      props.class,
    )}
  />
)

type TabsTriggerProps<T extends ValidComponent = "button"> = PolymorphicProps<
  T,
  TabsPrimitive.TabsTriggerProps<T>
> & {
  class?: string | undefined
}

const TabsTrigger = <T extends ValidComponent = "button">(
  props: TabsTriggerProps<T>,
) => (
  <TabsPrimitive.Trigger<T>
    {...props}
    class={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow",
      props.class,
    )}
  />
)

type TabsContentProps<T extends ValidComponent = "div"> = PolymorphicProps<
  T,
  TabsPrimitive.TabsContentProps<T>
> & {
  class?: string | undefined
}

const TabsContent = <T extends ValidComponent = "div">(
  props: TabsContentProps<T>,
) => (
  <TabsPrimitive.Content<T>
    {...props}
    class={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      props.class,
    )}
  />
)

export { Tabs, TabsList, TabsTrigger, TabsContent }
