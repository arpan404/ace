import type { Automation, AutomationRun } from "@ace/protocol";
import {
  ArrowsClockwiseIcon,
  CalendarBlankIcon,
  ClockIcon,
  FileIcon,
  GitPullRequestIcon,
  HandPointingIcon,
  PlusIcon,
  WarningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { cn } from "@/lib/cn.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { Icon } from "@/components/icon.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { ViewSidebarError, useViewListKeys } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { describeTrigger } from "./schedule.ts";
import { useAutomationRuns, useAutomations } from "./use-automations.ts";
import { useProjectName } from "@/lib/projects.ts";

const triggerIcons: Record<Automation["trigger"]["kind"], PhosphorIcon> = {
  schedule: ClockIcon,
  github: GitPullRequestIcon,
  file: FileIcon,
  manual: HandPointingIcon,
};

/** The glyph says how it fires: a clock daily, arrows every few hours, a calendar weekly. */
function triggerIcon(trigger: Automation["trigger"]): PhosphorIcon {
  if (trigger.kind !== "schedule") return triggerIcons[trigger.kind];
  const expression = trigger.schedule.expression.toUpperCase();
  if (/FREQ=(HOURLY|MINUTELY)/.test(expression)) return ArrowsClockwiseIcon;
  const weekly =
    expression.includes("FREQ=WEEKLY") ||
    (trigger.schedule.kind === "cron" && !expression.trim().endsWith("*"));
  return weekly ? CalendarBlankIcon : ClockIcon;
}

/** Each automation's latest run that failed, by automation id (runs come newest first). */
function useLastFailed(): ReadonlySet<string> {
  const runs = useAutomationRuns().data;
  return useMemo(() => {
    const latest = new Map<string, AutomationRun>();
    for (const run of runs ?? [])
      if (!latest.has(run.automationId)) latest.set(run.automationId, run);
    return new Set(
      [...latest.values()].filter((run) => run.status === "failed").map((run) => run.automationId),
    );
  }, [runs]);
}

/** The trigger and project live in the row's tooltip; pauses and failures stay visible. */
export function AutomationsSidebar() {
  const list = useAutomations();
  const automations = list.data;
  const failed = useLastFailed();
  const selected = useParams({ strict: false }).automationId;
  const projectName = useProjectName();
  const keys = useViewListKeys<HTMLUListElement>();
  return (
    <ViewSidebar
      title="Automations"
      actions={
        automations?.length ? (
          <Tip label="New automation">
            <Link
              to="/automations/new"
              aria-label="New automation"
              className={cn(buttonVariants({ variant: "ghost" }), "size-[30px] px-0")}
            >
              <Icon icon={PlusIcon} size={16} />
            </Link>
          </Tip>
        ) : undefined
      }
    >
      {!automations && list.isError ? (
        <ViewSidebarError onRetry={() => void list.refetch()} />
      ) : !automations ? (
        <ListSkeleton label="automations" shape="row" rows={4} />
      ) : !automations.length ? null : (
        <ul {...keys} aria-label="Automations" className="flex flex-col gap-px">
          {automations.map(({ automation, lastPollError }) => (
            <li key={automation.id}>
              <Tip
                label={`${describeTrigger(automation.trigger)} · ${projectName(automation.workspace)}`}
              >
                <Link
                  to="/automations/$automationId"
                  params={{ automationId: automation.id }}
                  aria-current={selected === automation.id ? "page" : undefined}
                  data-view-row=""
                  className="flex h-9 items-center gap-2 rounded-md px-2.5 text-ui hover:bg-sidebar-accent focus-ring-inset aria-[current=page]:bg-foreground/8"
                >
                  <Icon
                    icon={triggerIcon(automation.trigger)}
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span data-view-row-title="" className="min-w-0 flex-1 truncate">
                    {automation.title}
                  </span>
                  <RowMarks
                    paused={!automation.enabled}
                    failed={failed.has(automation.id) || lastPollError !== undefined}
                  />
                </Link>
              </Tip>
            </li>
          ))}
        </ul>
      )}
    </ViewSidebar>
  );
}

function RowMarks(props: { paused: boolean; failed: boolean }) {
  if (!props.paused && !props.failed) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {props.failed && (
        <Icon icon={WarningIcon} size={12} label="Needs attention" className="text-status-failed" />
      )}
      {props.paused && <StatusLabel tone="idle" label="Paused" />}
    </span>
  );
}
