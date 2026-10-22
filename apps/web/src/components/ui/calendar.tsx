import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import {
  addDays,
  addMonths,
  dateLabel,
  monthGrid,
  monthLabel,
  monthOf,
  readDateKey,
  type DateKey,
} from "./date-grid.ts";
import { IconButton } from "./icon-button.tsx";

const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A month of days to pick from, opening on the chosen day (or today). Days before `min` can't be
 * picked. Arrows move by day and week, Page Up/Down by month, Enter picks. It takes focus when it
 * mounts, so it belongs inside a popup.
 */
export function Calendar(props: {
  value: DateKey | undefined;
  /** Today in the zone that matters to the caller. */
  today: DateKey;
  min?: DateKey | undefined;
  onPick(value: DateKey): void;
}) {
  const chosen = props.value && readDateKey(props.value) ? props.value : undefined;
  const [focused, setFocused] = useState(chosen ?? props.today);
  const grid = useRef<HTMLDivElement>(null);
  const view = monthOf(focused);
  const allowed = (key: DateKey) => !props.min || key >= props.min;

  useEffect(() => {
    grid.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`)?.focus();
  }, [focused]);

  const pick = (key: DateKey) => {
    if (allowed(key)) props.onPick(key);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const step: Record<string, () => DateKey> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      PageUp: () => addMonths(focused, -1),
      PageDown: () => addMonths(focused, 1),
    };
    const move = step[event.key];
    if (move) {
      event.preventDefault();
      setFocused(move());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(focused);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between pl-1.5">
        <span aria-live="polite" className="text-ui font-medium">
          {monthLabel(view)}
        </span>
        <span className="flex items-center gap-0.5">
          <IconButton
            icon={CaretLeftIcon}
            label="Previous month"
            size="sm"
            disabled={!!props.min && addMonths(view, -1) < monthOf(props.min)}
            onClick={() => setFocused(addMonths(focused, -1))}
          />
          <IconButton
            icon={CaretRightIcon}
            label="Next month"
            size="sm"
            onClick={() => setFocused(addMonths(focused, 1))}
          />
        </span>
      </div>
      <div
        ref={grid}
        role="grid"
        aria-label={monthLabel(view)}
        onKeyDown={onKeyDown}
        className="grid grid-cols-7 gap-0.5"
      >
        {weekdays.map((day, index) => (
          <span
            key={weekdayNames[index]}
            role="columnheader"
            aria-label={weekdayNames[index]}
            className="flex h-6 items-center justify-center text-2xs text-subtle-foreground"
          >
            {day}
          </span>
        ))}
        {monthGrid(view).map(({ key, inMonth }) => {
          const isChosen = key === chosen;
          const isToday = key === props.today;
          return (
            <button
              key={key}
              type="button"
              role="gridcell"
              data-date={key}
              tabIndex={key === focused ? 0 : -1}
              aria-selected={isChosen}
              aria-current={isToday ? "date" : undefined}
              aria-label={dateLabel(key, props.today)}
              disabled={!allowed(key)}
              onClick={() => pick(key)}
              className={cn(
                "flex h-7 items-center justify-center rounded-sm text-ui tabular-nums transition-colors duration-(--motion-fast) focus-ring-inset",
                isChosen ? "bg-primary font-medium text-primary-foreground" : "hover:bg-hover",
                !isChosen && isToday && "font-medium text-ring-text",
                !isChosen && !isToday && (inMonth ? "text-foreground" : "text-subtle-foreground"),
                "disabled:pointer-events-none disabled:opacity-40",
              )}
            >
              {readDateKey(key)?.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
