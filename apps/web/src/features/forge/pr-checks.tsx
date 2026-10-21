import { useState } from "react";
import {
  ArrowClockwiseIcon,
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

/**
 * The PR's checks, folded by default: each with its state, opening in place to its log,
 * annotations and re-runs (read only then). When the host couldn't say, one inline Refresh,
 * the panel's only one.
 */
export function PrChecks(props: {
  context: PrWorkspaceContext;
  refreshing: boolean;
  reveal?: number | undefined;
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
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <PrSection
      id="pr-checks"
      title="Checks"
      count={status.checks.length || undefined}
      defaultOpen={false}
      reveal={props.reveal}
    >
      {stale && (
        <p className="flex items-center gap-2 text-ui text-muted-foreground">
          Check details are out of date.
          <Button variant="ghost" size="xs" disabled={props.refreshing} onClick={props.onRefresh}>
            <ArrowClockwiseIcon aria-hidden size={14} />
            Refresh
          </Button>
        </p>
      )}
      {(showLocal || status.checks.length > 0) && (
        <ul>
          {showLocal && (
            <LocalCheckRow
              workspaceId={workspaceId}
              detail={props.context.detail}
              run={local.run}
              command={local.command}
              onSetCommand={
                dialogs ? () => dialogs.open({ kind: "edit", projectId: workspaceId }) : undefined
              }
            />
          )}
          {status.checks.map((check) => {
            const look = checkLook[check.status];
            const Glyph = look.icon;
            const open = opened.has(check.id);
            return (
              <li key={check.id}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${check.name}: ${look.word}`}
                  onClick={() => toggle(check.id)}
                  className="flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-ui transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover aria-expanded:bg-active"
                >
                  <Glyph aria-hidden size={14} className={cn("shrink-0", look.tone)} />
                  <span className="min-w-0 flex-1 break-words">{check.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{look.word}</span>
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
        </ul>
      )}
      {!status.checks.length && !stale && (
        <p className="text-ui text-muted-foreground">No checks reported.</p>
      )}
    </PrSection>
  );
}
