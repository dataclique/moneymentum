import { createSignal, For, Show, type JSX } from "solid-js"

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  createSolidTable,
} from "@tanstack/solid-table"
import { createVirtualizer, type VirtualItem } from "@tanstack/solid-virtual"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const ESTIMATED_ROW_HEIGHT_PX = 34
const OVERSCAN_ROW_COUNT = 10
const TABLE_CONTAINER_HEIGHT_PX = 500

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
}

export const DataTable = <TData, TValue>(
  props: DataTableProps<TData, TValue>,
): JSX.Element => {
  const [sorting, setSorting] = createSignal<SortingState>([])
  let tableContainerRef!: HTMLDivElement

  const table = createSolidTable({
    get data() {
      return props.data
    },
    get columns() {
      return props.columns
    },
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    state: {
      get sorting() {
        return sorting()
      },
    },
  })

  const rows = () => table.getRowModel().rows

  const rowVirtualizer = createVirtualizer({
    get count() {
      return rows().length
    },
    getScrollElement: () => tableContainerRef,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROW_COUNT,
  })

  const virtualRows = () => rowVirtualizer.getVirtualItems()
  const totalSize = () => rowVirtualizer.getTotalSize()

  const paddingTop = () => {
    const items = virtualRows()
    return items.length > 0 ? (items[0]?.start ?? 0) : 0
  }

  const paddingBottom = () => {
    const items = virtualRows()
    return items.length > 0
      ? totalSize() - (items[items.length - 1]?.end ?? 0)
      : 0
  }

  return (
    <div
      class="w-full overflow-auto rounded-md border"
      style={{ height: `${String(TABLE_CONTAINER_HEIGHT_PX)}px` }}
      ref={tableContainerRef}
    >
      <Table>
        <TableHeader>
          <For each={table.getHeaderGroups()}>
            {headerGroup => (
              <TableRow>
                <For each={headerGroup.headers}>
                  {header => (
                    <TableHead colSpan={header.colSpan}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </TableHead>
                  )}
                </For>
              </TableRow>
            )}
          </For>
        </TableHeader>
        <TableBody>
          <Show when={paddingTop() > 0}>
            <tr>
              <td
                colSpan={props.columns.length}
                style={{ height: `${String(paddingTop())}px` }}
              />
            </tr>
          </Show>
          <For each={virtualRows()}>
            {(virtualRow: VirtualItem) => {
              const row = rows()[virtualRow.index] as
                | ReturnType<typeof rows>[number]
                | undefined
              if (!row) return null
              return (
                <TableRow>
                  <For each={row.getVisibleCells()}>
                    {cell => (
                      <TableCell>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    )}
                  </For>
                </TableRow>
              )
            }}
          </For>
          <Show when={paddingBottom() > 0}>
            <tr>
              <td
                colSpan={props.columns.length}
                style={{ height: `${String(paddingBottom())}px` }}
              />
            </tr>
          </Show>
        </TableBody>
      </Table>
    </div>
  )
}

export type { DataTableProps }
