import type { ReactNode } from "react";
import { CaretDownIcon, XIcon } from "@phosphor-icons/react";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * How many a view holds, honestly: its total once known; "2 of 12" when a total is known but
 * only some rows are; "12+" when more pages wait and no total is known.
 */
export function countWords(shown: number, total: number | undefined, complete: boolean): string {
  if (total !== undefined && total > shown) return `${shown} of ${total}`;
  if (total !== undefined) return String(total);
  return complete ? String(shown) : `${shown}+`;
}

export interface QuickView<T extends string> {
  id: T;
  label: string;
  count: string | undefined;
  icon?: ReactNode;
}

/**
 * The box header's state toggles, GitHub's "Open 642  Closed 19,895": each a word with its
 * count, the one on show in the text colour and bold.
 */
export function StateToggles<T extends string>(props: {
  label: string;
  views: readonly QuickView<T>[];
  /** The toggle on show; none when the address asks for a state no toggle names. */
  value: T | undefined;
  onValue(value: T): void;
}) {
  return (
    <div role="group" aria-label={props.label} className="flex min-w-0 flex-wrap items-center">
      {props.views.map((view) => {
        const on = view.id === props.value;
        return (
          <button
            key={view.id}
            type="button"
            aria-pressed={on}
            onClick={() => props.onValue(view.id)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui whitespace-nowrap transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
              on ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {view.icon}
            {view.label}
            {view.count !== undefined && (
              <span
                className={cn(
                  "rounded-full bg-fill px-1.5 text-xs leading-[18px] font-medium tabular-nums",
                  on ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {view.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A preset search before the search line ("Needs you", "Review requested"…), GitHub's filter
 * presets: a menu of views with their counts, the button naming the one on show.
 */
export function PresetMenu<T extends string>(props: {
  label: string;
  views: readonly QuickView<T>[];
  value: T | undefined;
  onValue(value: T): void;
}) {
  const current = props.views.find((view) => view.id === props.value);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${props.label}: ${current?.label ?? "Custom"}`}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-ui font-medium text-foreground focus-ring transition-colors duration-(--motion-fast) hover:bg-hover aria-expanded:bg-hover"
      >
        <span className="max-w-36 truncate">{current?.label ?? "Filters"}</span>
        <CaretDownIcon aria-hidden size={13} className="text-muted-foreground" />
      </MenuTrigger>
      <MenuContent aria-label={props.label} align="start" className="min-w-56">
        <MenuRadioGroup
          value={props.value ?? ""}
          onValueChange={(value: unknown) => {
            const picked = props.views.find((view) => view.id === value);
            if (picked) props.onValue(picked.id);
          }}
        >
          {props.views.map((view) => (
            <MenuRadioItem key={view.id} value={view.id}>
              <span className="flex min-w-0 flex-1 items-center gap-4">
                <span className="flex-1">{view.label}</span>
                {view.count !== undefined && (
                  <span className="text-subtle-foreground tabular-nums">{view.count}</span>
                )}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** GitHub's line over a filtered box: a way back to the list as it starts. */
export function ClearLine(props: { onClear(): void }) {
  return (
    <button
      type="button"
      onClick={props.onClear}
      className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-ui font-medium text-muted-foreground focus-ring hover:text-link"
    >
      <XIcon
        aria-hidden
        size={14}
        weight="bold"
        className="rounded-xs bg-muted-foreground p-px text-background"
      />
      Clear current search query, filters, and sorts
    </button>
  );
}
