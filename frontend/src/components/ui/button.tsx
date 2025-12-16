import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import type { VariantProps } from "class-variance-authority"

import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { buttonVariants } from "@/lib/button-variants"

const Button = ({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) => {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={twMerge(clsx(buttonVariants({ variant, size, className })))}
      {...props}
    />
  )
}

export { Button }
