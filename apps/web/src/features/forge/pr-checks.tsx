import { useEffect, useState } from "react";
import { formatElapsed } from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgeCheck } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { PrSection } from "./pr-section.tsx";
import { PrCheckDetail } from "./pr-check-detail.tsx";
import { LocalCheckRow } from "./pr-local-check-row.tsx";
import { usePrLocalCheck } from "./pr-local-check.ts";
import { useProjectDialogsIfHosted } from "@/features/projects/index.ts";

const checkLook: Record<
  ForgeCheck["status"],
  { icon: typeof CircleIcon; word: string; tone: string }
> = {
  success: { icon: CheckCircleIcon, word: "Passed", tone: "text-status-done" },
  failure: { icon: XCircleIcon, word: "Failed", tone: "text-status-failed" },
  pending: { icon: ClockIcon, word: "Running", tone: "text-status-working" },
  cancelled: { icon: MinusCircleIcon, word: "Cancelled", tone: "text-subtle-foreground" },
  unknown: { icon: CircleIcon, word: "Unknown", tone: "text-subtle-foreground" },
};

/** Failures first, then what still runs, then the rest; passed last. */
const order: Record<ForgeCheck["status"], number> = {
  failure: 0,
  pending: 1,
  cancelled: 2,
  unknown: 3,
  success: 4,
};

/** How long a check ran, or has run so far: "4m 12s". Undefined when its start is unknown. */
function duration(check: ForgeCheck, now: number): string | undefined {
  const start = check.startedAt ? Date.parse(check.startedAt) : NaN;
  if (!Number.isFinite(start)) return undefined;
  const end = check.completedAt ? Date.parse(check.completedAt) : now;
  return Number.isFinite(end) ? formatElapsed(end - start) : undefined;
}

/**
 * The PR's checks as the Checks tab: failures first, each with its state and how long it ran,
 * opening in place to its log, annotations and re-runs (read only then). `focus` opens one
 * (Open log from Blocking the merge). When the host couldn't say, one inline Refresh.
 */
export function PrChecks(props: {
  context: PrWorkspaceContext;
  refreshing: boolean;
  /** Opens this check and scrolls to it; `seq` repeats a jump to the same one. */
  focus?: { id: string; seq: number } | undefined;
  hostThreadId?: string | undefined;
  onRefresh(): void;
  onOpen(number: number): void;
  onOpenCode(path: string): void;
}) {
  const { status } = props.context.detail;
  const stale = status.ci === "unknown";
  const local = usePrLocalCheck(props.context.workspaceId, status);
  const dialogs = useProjectDialogsIfHosted();
  const workspaceId = props.context.workspaceId;
  // Open PRs always show their local check; finished ones only one that ran.
  const unfinished = status.state === "open" || status.state === "draft";
  const showLocal = local.run !== undefined || (unfinished && local.command !== undefined);
  const now = useNow();
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(props.focus ? [props.focus.id] : []),
  );
  // A new focus opens its check during render; the row scrolls itself into view.
  const [focused, setFocused] = useState(props.focus);
  if (props.focus !== focused) {
    setFocused(props.focus);
    const id = props.focus?.id;
    if (id && !opened.has(id)) setOpened(new Set([...opened, id]));
  }
  useEffect(() => {
    if (focused)
      document
        .getElementById(`pr-check-${focused.id}`)
        ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [focused]);
  const checks = status.checks.toSorted(
    (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name),
  );
  const failing = checks.filter((check) => check.status === "failure").length;
  // The local check leads only when it failed; otherwise it follows GitHub's.
  const localFailed = local.result === "failed";
  const localRow = showLocal && (
    <LocalCheckRow
      workspaceId={workspaceId}
      detail={props.context.detail}
      run={local.run}
      command={local.command}
      onSetCommand={
        dialogs ? () => dialogs.open({ kind: "edit", projectId: workspaceId }) : undefined
      }
    />
  );
  const toggle = (id: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <PrSection
      id="pr-checks"
      title={failing ? `${failing} of ${checks.length} failing` : "Checks"}
      count={failing ? undefined : checks.length || undefined}
      fixed
    >
      {stale && (
        <p className="flex items-center gap-2 text-ui text-muted-foreground">
          Check details are out of date.
          <Button variant="ghost" size="xs" disabled={props.refreshing} onClick={props.onRefresh}>
            Refresh
          </Button>
        </p>
      )}
      {(showLocal || status.checks.length > 0) && (
        <ul>
          {localFailed && localRow}
          {checks.map((check) => {
            const look = checkLook[check.status];
            const Glyph = look.icon;
            const open = opened.has(check.id);
            const took = duration(check, now);
            return (
              <li key={check.id} id={`pr-check-${check.id}`} className="scroll-mt-12">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${check.name}: ${look.word}`}
                  onClick={() => toggle(check.id)}
                  className="flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-ui transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover aria-expanded:bg-active"
                >
                  <Glyph aria-hidden size={14} className={cn("shrink-0", look.tone)} />
                  <span className="min-w-0 flex-1 break-words">{check.name}</span>
                  {took && (
                    <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                      {took}
                    </span>
                  )}
                  <span
                    className={cn(
                      "w-16 shrink-0 text-right text-xs",
                      check.status === "failure" ? look.tone : "text-muted-foreground",
                    )}
                  >
                    {look.word}
                  </span>
                  <CaretRightIcon
                    aria-hidden
                    size={12}
                    className={cn(
                      "shrink-0 text-faint-foreground transition-transform duration-(--motion-fast)",
                      open && "rotate-90",
                    )}
                  />
                </button>
                {open && (
                  <PrCheckDetail
                    context={props.context}
                    check={check}
                    hostThreadId={props.hostThreadId}
                    onOpen={props.onOpen}
                    onOpenCode={props.onOpenCode}
                  />
                )}
              </li>
            );
          })}
          {!localFailed && localRow}
        </ul>
      )}
      {!status.checks.length && !stale && !showLocal && (
        <p className="text-ui text-muted-foreground">No checks reported.</p>
      )}
    </PrSection>
  );
}
