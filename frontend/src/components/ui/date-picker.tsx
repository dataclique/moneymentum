import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface Calendar22Props {
  label: string
  selected?: Date | null
  onChange?: (date: Date | null) => void
  minDate?: Date
  maxDate?: Date
}

export const Calendar22 = ({
  label,
  selected,
  onChange,
  minDate,
  maxDate,
}: Calendar22Props) => {
  const [open, setOpen] = React.useState(false)

  const disabledDays: ({ before: Date } | { after: Date })[] = []
  if (minDate) {
    disabledDays.push({ before: minDate })
  }
  if (maxDate) {
    disabledDays.push({ after: maxDate })
  }

  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="date" className="px-1">
        {label}
      </Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            id="date"
            className="w-48 justify-between font-normal"
          >
            {selected
              ? selected.toLocaleDateString("ru-RU", { timeZone: "UTC" })
              : "Select date"}
            <ChevronDownIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto overflow-hidden p-0" align="start">
          <Calendar
            mode="single"
            selected={selected ?? undefined}
            captionLayout="dropdown"
            startMonth={minDate}
            endMonth={maxDate}
            onSelect={date => {
              if (date) {
                const utcDate = new Date(
                  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
                )
                onChange?.(utcDate)
              } else {
                onChange?.(null)
              }
              setOpen(false)
            }}
            disabled={disabledDays}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
