import { planCount, type PlanProgress } from "@ace/ui-core";
import type { TodoEntry } from "@ace/protocol";
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CircleIcon,
  ListChecksIcon,
  ShieldWarningIcon,
  TrayIcon,
  WifiSlashIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useId, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { OfflineWaiting } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import type { StripKind } from "./strip-slot.ts";

/** What an indicator says about an item the slot isn't showing. */
export interface StripCounts {
  requests: number;
  /** The connection is down rather than coming back. */
  offline: boolean;
  queued: number;
  plan: Pick<PlanProgress, "done" | "total"> | undefined;
}

/**
 * The strip's other items as small buttons, in priority order: "2 requests", "Offline",
 * "2 queued", "3/5". Choosing one shows it in the slot.
 */
export function StripIndicators(props: {
  kinds: readonly StripKind[];
  counts: StripCounts;
  onPick(kind: StripKind): void;
}) {
  if (!props.kinds.length) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      {props.kinds.map((kind) => (
        <Indicator key={kind} kind={kind} counts={props.counts} onPick={props.onPick} />
      ))}
    </span>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Indicator(props: { kind: StripKind; counts: StripCounts; onPick(kind: StripKind): void }) {
  const { counts } = props;
  const [icon, text, label]: [ReactNode, string, string] =
    props.kind === "request"
      ? [
          <Icon key="i" icon={ShieldWarningIcon} size={14} />,
          plural(counts.requests, "request"),
          `Show ${plural(counts.requests, "request")} waiting for you`,
        ]
      : props.kind === "connection"
        ? counts.offline
          ? [<Icon key="i" icon={WifiSlashIcon} size={14} />, "Offline", "Show connection: Offline"]
          : [<Spinner key="i" />, "Reconnecting", "Show connection: Reconnecting"]
        : props.kind === "queue"
          ? [
              <Icon key="i" icon={TrayIcon} size={14} />,
              `${counts.queued} queued`,
              `Show ${plural(counts.queued, "queued message")}`,
            ]
          : [
              <Icon key="i" icon={ListChecksIcon} size={14} />,
              counts.plan ? `${counts.plan.done}/${counts.plan.total}` : "Plan",
              counts.plan ? `Show plan, ${planCount(counts.plan)} done` : "Show plan",
            ];
  return (
    <button
      type="button"
      aria-label={label}
      data-tone={props.kind === "request" ? "needs-you" : undefined}
      onClick={() => props.onPick(props.kind)}
      className="composer-strip-indicator focus-ring-inset tabular-nums"
    >
      {icon}
      {text}
    </button>
  );
}

/**
 * Trouble reaching the daemon, in the strip: "Reconnecting…", or Offline with what still works.
 * Agents keep working on the daemon meanwhile; nothing here says otherwise.
 */
export function ConnectionStrip(props: {
  offline: boolean;
  onRetry(): void;
  indicators: ReactNode;
}) {
  return (
    <div role="status" className="flex h-9 min-w-0 items-center gap-2 px-1 text-ui">
      {props.offline ? (
        <Icon icon={WifiSlashIcon} size={14} className="shrink-0 text-muted-foreground" />
      ) : (
        <Spinner />
      )}
      <span className="min-w-0 truncate">
        {props.offline ? (
          <OfflineWaiting
            idle={
              <>
                <span className="text-foreground">Offline</span>
                <span className="text-muted-foreground">
                  {" "}
                  · messages will send when you're back
                </span>
              </>
            }
          />
        ) : (
          <span className="text-foreground">Reconnecting…</span>
        )}
      </span>
      <IconButton icon={ArrowClockwiseIcon} label="Retry now" size="sm" onClick={props.onRetry} />
      {props.indicators}
    </div>
  );
}

/**
 * The main agent's plan in the strip: "Plan · 3 of 5" and the step in progress, opening to the
 * whole list.
 */
export function PlanStrip(props: { progress: PlanProgress; indicators: ReactNode }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { progress } = props;
  return (
    <section aria-label="Plan" className="text-ui">
      <div className="flex h-9 min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
          className="flex h-7 min-w-0 items-center gap-2 rounded-sm px-1 text-muted-foreground focus-ring-inset hover:text-foreground"
        >
          <Icon icon={ListChecksIcon} size={14} className="shrink-0" />
          <span className="shrink-0 text-foreground">Plan · {planCount(progress)}</span>
          {!open && progress.current && (
            <span className="min-w-0 truncate text-xs">{progress.current.content}</span>
          )}
          <Icon icon={open ? CaretUpIcon : CaretDownIcon} size={12} className="shrink-0" />
        </button>
        {props.indicators}
      </div>
      <ol id={listId} hidden={!open} aria-label="Plan steps" className="space-y-1.5 px-1 pb-1">
        {progress.todos.map((todo, index) => (
          <li
            // oxlint-disable-next-line react/no-array-index-key -- positional provider todos may repeat text.
            key={todo.id ?? index}
            aria-current={todo.status === "in_progress" ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-2",
              todo.status === "in_progress"
                ? "font-medium text-foreground"
                : "text-muted-foreground",
              todo.status === "cancelled" && "line-through",
            )}
          >
            <TodoGlyph status={todo.status} />
            <span className="min-w-0 truncate">{todo.content}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TodoGlyph(props: { status: TodoEntry["status"] }) {
  if (props.status === "in_progress") return <Spinner />;
  const [icon, tone, label] =
    props.status === "completed"
      ? [CheckCircleIcon, "text-status-done", "Done"]
      : props.status === "cancelled"
        ? [XCircleIcon, "text-subtle-foreground", "Cancelled"]
        : [CircleIcon, "text-subtle-foreground", "To do"];
  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0">
      <Icon icon={icon} size={14} className={tone} />
    </span>
  );
}
