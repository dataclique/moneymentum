import type { ColumnDef, SortingState } from "@tanstack/solid-table"
import {
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
} from "@tanstack/solid-table"
import {
  For,
  createSignal,
  splitProps,
  type Accessor,
  type JSX,
} from "solid-js"

import { cn } from "@/lib/cn"

import { AllSymbolsRow } from "./AllSymbolsRow"
import type { AllSymbolRowData } from "./allSymbolRowModel"
import { DEFAULT_ALL_SYMBOLS_SORTING } from "./allSymbolsColumns"

const allHeaderClass = (columnId: string): string => {
  const base =
    "px-2 py-1 font-medium text-muted-foreground text-[10px] overflow-visible"
  if (columnId === "asset") {
    return `${base} text-left pr-3`
  }
  return `${base} text-right pl-3`
}

interface AllSymbolsDataTableProps {
  columns: ColumnDef<AllSymbolRowData>[]
  data: Accessor<AllSymbolRowData[]>
  targetSymbols: Set<string>
  closingSymbols: Set<string>
  fundingIsLoading: boolean
  factorsIsLoading: boolean
  onSymbolClick: (symbol: string) => void
  class?: string
}

export const AllSymbolsDataTable = (
  props: AllSymbolsDataTableProps,
): JSX.Element => {
  const [local] = splitProps(props, [
    "columns",
    "data",
    "targetSymbols",
    "closingSymbols",
    "fundingIsLoading",
    "factorsIsLoading",
    "onSymbolClick",
    "class",
  ])
  const [sorting, setSorting] = createSignal<SortingState>([
    ...DEFAULT_ALL_SYMBOLS_SORTING,
  ])

  const table = createSolidTable({
    get data() {
      return local.data()
    },
    get columns() {
      return local.columns
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      get sorting() {
        return sorting()
      },
    },
  })

  const rows = () => table.getRowModel().rows

  return (
    <div class={cn("w-full", local.class)}>
      <table class="w-full">
        <thead class="sticky top-0 z-10 bg-muted/90">
          <For each={table.getHeaderGroups()}>
            {headerGroup => (
              <tr>
                <For each={headerGroup.headers}>
                  {header => (
                    <th
                      colSpan={header.colSpan}
                      class={allHeaderClass(header.column.id)}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </th>
                  )}
                </For>
              </tr>
            )}
          </For>
        </thead>
        <tbody>
          <For each={rows()}>
            {row => (
              <AllSymbolsRow
                row={row.original}
                isInTarget={local.targetSymbols.has(row.original.symbol)}
                isClosing={local.closingSymbols.has(row.original.symbol)}
                fundingIsLoading={local.fundingIsLoading}
                factorsIsLoading={local.factorsIsLoading}
                onSymbolClick={local.onSymbolClick}
              />
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}
