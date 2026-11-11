import type { KeyboardEvent, ReactNode } from "react";
import { checkLook, formatElapsed } from "@ace/ui-core";
import type { ForgeCheck } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { prBox } from "./pr-box.tsx";
import { CheckDisc, discTone, type DiscTone } from "./pr-check-disc.tsx";

/** Failures first, then what still runs, then the rest; passed last. */
const order: Record<ForgeCheck["status"], number> = {
  failure: 0,
  pending: 1,
  cancelled: 2,
  unknown: 3,
  success: 4,
};

export function sortChecks(checks: readonly ForgeCheck[]): ForgeCheck[] {
  return checks.toSorted(
    (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name),
  );
}

/** How long a check ran, or has run so far: "4m 12s". Undefined when its start is unknown. */
export function checkDuration(check: ForgeCheck, now: number): string | undefined {
  const start = check.startedAt ? Date.parse(check.startedAt) : NaN;
  if (!Number.isFinite(start)) return undefined;
  const end = check.completedAt ? Date.parse(check.completedAt) : now;
  return Number.isFinite(end) ? formatElapsed(end - start) : undefined;
}

/** "1 failing · 1 running · 2 passed": the Checks tab's context in the tab bar. */
export function checksTally(checks: readonly Pick<ForgeCheck, "status">[]): string {
  const count = (status: ForgeCheck["status"]) =>
    checks.filter((check) => check.status === status).length;
  return [
    [count("failure"), "failing"],
    [count("pending"), "running"],
    [count("success"), "passed"],
    [count("cancelled"), "cancelled"],
  ]
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");
}

export function PrChecksTally(props: { checks: readonly Pick<ForgeCheck, "status">[] }) {
  const tally = checksTally(props.checks);
  if (!tally) return null;
  return <span className="text-xs text-muted-foreground tabular-nums">{tally}</span>;
}

/** A check's disc tone and its state in a word. */
export function checkState(check: Pick<ForgeCheck, "status">): { tone: DiscTone; word: string } {
  const look = checkLook[check.status];
  return { tone: check.status === "unknown" ? "off" : discTone(look.tone), word: look.word };
}

/** Where a set of checks ran: "Checks on a1c9e2f", "On this machine". */
export function CheckGroup(props: { title: ReactNode; children: ReactNode }) {
  return (
    <li className="border-t border-border-soft first:border-t-0">
      <p className="px-3.5 pt-2 pb-1 text-xs font-semibold text-subtle-foreground">{props.title}</p>
      <ul>{props.children}</ul>
    </li>
  );
}

/**
 * One check in the list: its disc, its name, what it took (or an action) at the right. The
 * selected one is filled with an ink bar at its left edge.
 */
export function CheckRow(props: {
  label: string;
  name: string;
  tone: DiscTone;
  selected: boolean;
  onSelect(): void;
  trailing?: ReactNode;
  /** An action beside the row, outside its button: Run, Set a check command. */
  action?: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-center border-t border-border-soft transition-colors duration-(--motion-fast) first:border-t-0 hover:bg-hover",
        props.selected &&
          "bg-active shadow-[inset_2px_0_0_var(--color-foreground)] hover:bg-active",
      )}
    >
      <button
        type="button"
        data-check-row
        aria-current={props.selected || undefined}
        aria-label={props.label}
        onClick={props.onSelect}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 py-2 pr-2 pl-3.5 text-left text-ui focus-ring-inset"
      >
        <CheckDisc tone={props.tone} />
        <span className="min-w-0 flex-1 break-words text-foreground">{props.name}</span>
        {props.trailing && (
          <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
            {props.trailing}
          </span>
        )}
      </button>
      {props.action && <div className="shrink-0 pr-3">{props.action}</div>}
    </li>
  );
}

/** Up and Down move between the checks, selecting as they go. */
function onListKey(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-check-row]")];
  const at = rows.findIndex((row) => row === document.activeElement);
  if (at < 0) return;
  const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
}

/** The left pane: every check, grouped by where it ran. */
export function ChecksListBox(props: { children: ReactNode }) {
  return (
    <ul aria-label="Checks" onKeyDown={onListKey} className={cn(prBox, "overflow-hidden")}>
      {props.children}
    </ul>
  );
}
