import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export const mergeClassNames = (...inputs: ClassValue[]): string => {
  return twMerge(clsx(inputs))
}

export const cn = mergeClassNames
