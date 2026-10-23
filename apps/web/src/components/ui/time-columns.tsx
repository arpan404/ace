import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { IconButton } from "./icon-button.tsx";
import { Input } from "./input.tsx";
import { displayTime, readTime } from "./time-picker.tsx";

const pad = (value: number) => String(value).padStart(2, "0");

/** "19:05" → hour 7 on a 12-hour clock, minute 5, PM. */
export function splitTime(time: string): { hour: number; minute: number; pm: boolean } {
  const [hours = 0, minute = 0] = time.split(":").map(Number);
  return { hour: hours % 12 || 12, minute, pm: hours >= 12 };
}

/** Hour 7, minute 5, PM → "19:05". */
export function joinTime(parts: { hour: number; minute: number; pm: boolean }): string {
  return `${pad((parts.hour % 12) + (parts.pm ? 12 : 0))}:${pad(parts.minute)}`;
}

const hours = Array.from({ length: 12 }, (_, index) => index + 1);
const minutes = Array.from({ length: 60 }, (_, index) => index);

/**
 * A time of day picked from three columns, hour, minute and AM/PM, with a box above for typing
 * one ("7:05 pm", "19:05"). Shown in place inside a popup rather than as another popup on top.
 * Every pick takes effect at once; arrows step within a column, Escape goes back.
 */
export function TimeColumns(props: {
  value: string;
  onChange(time: string): void;
  onBack(): void;
}) {
  const parts = splitTime(props.value);
  const set = (patch: Partial<typeof parts>) => props.onChange(joinTime({ ...parts, ...patch }));
  const back = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // Back to the panel, not out of it.
    event.preventDefault();
    event.stopPropagation();
    props.onBack();
  };
  return (
    <div role="group" aria-label="Time" className="flex min-h-0 flex-col gap-1" onKeyDown={back}>
      <div className="flex items-center gap-1">
        <IconButton icon={ArrowLeftIcon} label="Back" size="sm" onClick={props.onBack} />
        <TypedTime key={props.value} value={props.value} onCommit={props.onChange} />
      </div>
      <div className="flex h-[min(12rem,36dvh)] gap-1">
        <Column
          label="Hour"
          items={hours}
          value={parts.hour}
          text={String}
          onPick={(hour) => set({ hour })}
        />
        <Column
          label="Minute"
          items={minutes}
          value={parts.minute}
          text={pad}
          onPick={(minute) => set({ minute })}
        />
        <Column
          label="AM or PM"
          items={[0, 1]}
          value={parts.pm ? 1 : 0}
          text={(pm) => (pm ? "PM" : "AM")}
          onPick={(pm) => set({ pm: pm === 1 })}
        />
      </div>
    </div>
  );
}

function Column(props: {
  label: string;
  items: readonly number[];
  value: number;
  text(item: number): string;
  onPick(item: number): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-item="${props.value}"]`)
      ?.scrollIntoView?.({ block: "center" });
  }, [props.value]);
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = props.items.indexOf(props.value);
    const next = props.items[Math.min(Math.max(index + step, 0), props.items.length - 1)];
    if (next !== undefined) props.onPick(next);
  };
  return (
    <div
      ref={list}
      role="listbox"
      aria-label={props.label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-md focus-ring-inset [scrollbar-width:none]"
    >
      {props.items.map((item) => {
        const chosen = item === props.value;
        return (
          <button
            key={item}
            type="button"
            role="option"
            tabIndex={-1}
            data-item={item}
            aria-selected={chosen}
            onClick={() => props.onPick(item)}
            className={cn(
              "flex h-7 shrink-0 items-center justify-center rounded-sm text-ui tabular-nums transition-colors duration-(--motion-fast)",
              chosen ? "bg-primary font-medium text-primary-foreground" : "hover:bg-hover",
            )}
          >
            {props.text(item)}
          </button>
        );
      })}
    </div>
  );
}

/** The typed time: it takes effect on Enter or leaving the box. */
function TypedTime(props: { value: string; onCommit(time: string): void }) {
  const [text, setText] = useState(displayTime(props.value));
  const parsed = readTime(text);
  const commit = () => {
    if (parsed && parsed !== props.value) props.onCommit(parsed);
  };
  return (
    <Input
      aria-label="Exact time"
      value={text}
      onValueChange={setText}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      placeholder="7:05 PM"
      aria-invalid={parsed ? undefined : true}
      className="h-7 tabular-nums"
    />
  );
}
