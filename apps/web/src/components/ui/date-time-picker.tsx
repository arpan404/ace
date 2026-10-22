import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { Calendar } from "./calendar.tsx";
import type { DateKey } from "./date-grid.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { selectTrigger } from "./select.tsx";
import { TimeColumns } from "./time-columns.tsx";
import { displayTime } from "./time-picker.tsx";
import { cityOf, ZoneSearch } from "./zone-search.tsx";

export interface DateTime {
  /** "2026-10-24", or "" when none is chosen. */
  date: DateKey | "";
  /** "21:07". */
  time: string;
  /** An IANA zone, "America/New_York". */
  timezone: string;
}

/**
 * One moment, picked in one panel: a month calendar, an exact time and the zone it's read in.
 * Picking a day keeps the panel open so the time and zone can follow. The time and the zone are
 * picked in place of the calendar, so the panel never stacks another popup on top. `text` is the trigger's
 * words, which the caller owns ("Now", "Oct 25, 9:00 AM"). With `onClear`, the panel offers a
 * way back to no date ("Start now").
 */
export function DateTimePicker(props: {
  id?: string;
  label: string;
  value: DateTime;
  text: string;
  today: DateKey;
  min?: DateKey | undefined;
  zones: readonly string[];
  onChange(patch: Partial<DateTime>): void;
  clearLabel?: string;
  onClear?: (() => void) | undefined;
  className?: string;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"moment" | "time" | "zone">("moment");
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setView("moment");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        id={props.id}
        aria-label={`${props.label}: ${props.text}`}
        aria-invalid={props["aria-invalid"] || undefined}
        aria-describedby={props["aria-describedby"]}
        className={cn(selectTrigger, "tabular-nums", props.className)}
      >
        <span className="truncate">{props.text}</span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        aria-label={props.label}
        className="flex w-64 flex-col gap-2 p-2"
      >
        {view === "time" ? (
          <TimeColumns
            value={props.value.time}
            onChange={(time) => props.onChange({ time })}
            onBack={() => setView("moment")}
          />
        ) : view === "zone" ? (
          <ZoneSearch
            value={props.value.timezone}
            zones={props.zones}
            onPick={(timezone) => {
              props.onChange({ timezone });
              setView("moment");
            }}
            onBack={() => setView("moment")}
          />
        ) : (
          <>
            <Calendar
              value={props.value.date || undefined}
              today={props.today}
              min={props.min}
              onPick={(date) => props.onChange({ date })}
            />
            <div className="flex flex-col gap-1 border-t border-border pt-2">
              <Row label="Time">
                <ViewButton
                  label={`Time: ${displayTime(props.value.time)}`}
                  text={displayTime(props.value.time)}
                  onClick={() => setView("time")}
                />
              </Row>
              <Row label="Zone">
                <ViewButton
                  label={`Time zone: ${props.value.timezone}`}
                  text={cityOf(props.value.timezone)}
                  onClick={() => setView("zone")}
                />
              </Row>
            </div>
            {props.onClear && props.value.date && (
              <button
                type="button"
                onClick={() => {
                  props.onClear?.();
                  setOpen(false);
                }}
                className="self-start rounded-xs px-1 text-ui text-muted-foreground focus-ring hover:text-foreground hover:underline"
              >
                {props.clearLabel ?? "Clear"}
              </button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="w-10 shrink-0 text-ui text-muted-foreground">{props.label}</span>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

/** A row's value that opens its own view in place of the calendar. */
function ViewButton(props: { label: string; text: string; onClick(): void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={props.onClick}
      className={cn(selectTrigger, "h-7 w-full min-w-0 tabular-nums")}
    >
      <span className="truncate">{props.text}</span>
      <CaretRightIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
    </button>
  );
}
