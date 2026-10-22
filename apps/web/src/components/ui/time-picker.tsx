import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { Input } from "./input.tsx";
import { menuItem } from "./menu-styles.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { selectTrigger } from "./select.tsx";

const pad = (value: number) => String(value).padStart(2, "0");

/** "9:07 pm", "21:07" or "9:07" → "21:07"; undefined when it isn't a time of day. */
export function readTime(text: string): string | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/i.exec(text.trim());
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const period = match[3]?.toLowerCase().charAt(0);
  if (minute > 59 || hour > (period ? 12 : 23) || (period && hour < 1)) return undefined;
  if (period) hour = (hour % 12) + (period === "p" ? 12 : 0);
  return `${pad(hour)}:${pad(minute)}`;
}

/** "21:07" → "9:07 PM". */
export function displayTime(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return time;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

/** Every quarter hour of a day, "00:00" to "23:45". */
const quarters = Array.from(
  { length: 96 },
  (_, index) => `${pad(Math.floor(index / 4))}:${pad((index % 4) * 15)}`,
);

/**
 * A time field: the trigger reads "9:00 AM"; it opens a list of quarter hours, scrolled to the
 * chosen one, with a box on top for an exact time ("9:07 AM", "21:07"). Values are "HH:MM".
 */
export function TimePicker(props: {
  id?: string;
  label: string;
  value: string;
  onValueChange(value: string): void;
  className?: string;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const exact = typed ? readTime(typed) : undefined;
  // The chosen time when it's off the quarter hours, so it still shows in the list.
  const times = quarters.includes(props.value) ? quarters : [...quarters, props.value].toSorted();

  useEffect(() => {
    if (!open) return;
    // Next frame: the list is laid out once the popup has opened.
    const frame = requestAnimationFrame(() =>
      list.current
        ?.querySelector<HTMLElement>(`[data-time="${props.value}"]`)
        ?.scrollIntoView?.({ block: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, props.value]);

  const pick = (time: string) => {
    props.onValueChange(time);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setTyped("");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        id={props.id}
        aria-label={`${props.label}: ${displayTime(props.value)}`}
        aria-invalid={props["aria-invalid"] || undefined}
        aria-describedby={props["aria-describedby"]}
        className={cn(selectTrigger, "tabular-nums", props.className)}
      >
        <span className="truncate">{displayTime(props.value)}</span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={6} className="w-40 p-1">
        <Input
          aria-label="Exact time"
          value={typed}
          placeholder="Type a time"
          onValueChange={setTyped}
          onKeyDown={(event) => {
            if (event.key === "Enter" && exact) {
              event.preventDefault();
              pick(exact);
            }
          }}
          className="mb-1 h-7 tabular-nums"
        />
        <div
          ref={list}
          role="listbox"
          aria-label={props.label}
          className="max-h-56 overflow-y-auto"
        >
          {(exact ? [exact] : times).map((time) => (
            <button
              key={time}
              type="button"
              role="option"
              data-time={time}
              aria-selected={time === props.value}
              onClick={() => pick(time)}
              className={cn(menuItem, "tabular-nums hover:bg-accent")}
            >
              <span className="flex-1 text-left">{displayTime(time)}</span>
              {time === props.value && <CheckIcon aria-hidden size={14} />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
