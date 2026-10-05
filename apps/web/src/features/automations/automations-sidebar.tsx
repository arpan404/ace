import type { Automation, AutomationRun } from "@ace/protocol";
import {
  ArrowsClockwiseIcon,
  CalendarBlankIcon,
  CheckIcon,
  ClockIcon,
  FileIcon,
  GitPullRequestIcon,
  HandPointingIcon,
  PlusIcon,
  WarningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { ViewSidebarError } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import { runNeedsAttention, runSummary } from "./labels.ts";
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

/** Automations' list in the sidebar: every schedule and trigger, then the latest runs. */
export function AutomationsSidebar() {
  const list = useAutomations();
  const automations = list.data;
  const runs = useAutomationRuns().data;
  const selected = useParams({ strict: false }).automationId;
  const now = useNow();
  const projectName = useProjectName();
  return (
    <ViewSidebar
      title="Automations"
      actions={
        <Tip label="New automation">
          <Link
            to="/automations/new"
            aria-label="New automation"
            className={cn(buttonVariants({ variant: "ghost" }), "size-[30px] px-0")}
          >
            <Icon icon={PlusIcon} size={16} />
          </Link>
        </Tip>
      }
    >
      {!automations && list.isError ? (
        <ViewSidebarError onRetry={() => void list.refetch()} />
      ) : !automations ? (
        <ListSkeleton label="automations" shape="tile" rows={4} />
      ) : !automations.length ? (
        <EmptyState
          icon={ClockIcon}
          title="No automations"
          description="Run a prompt on a schedule or when something happens in a repository."
          className="h-auto pt-16"
        />
      ) : (
        <>
          <Section label="Schedules">
            {(automations ?? []).map(({ automation }) => (
              <Row
                key={automation.id}
                to={automation.id}
                selected={selected === automation.id}
                icon={<Icon icon={triggerIcon(automation.trigger)} size={16} />}
                title={automation.title}
                description={`${describeTrigger(automation.trigger)} · ${projectName(automation.workspace)}`}
                trailing={automation.enabled ? undefined : "off"}
              />
            ))}
          </Section>
          {!!runs?.length && (
            <Section label="Recent runs">
              {runs.slice(0, 6).map((run) => (
                <Row
                  key={run.id}
                  to={run.automationId}
                  selected={false}
                  icon={runMark(run)}
                  title={run.title}
                  description={runSummary(run)}
                  trailing={formatAge(run.finishedAt ?? run.startedAt, now)}
                />
              ))}
            </Section>
          )}
        </>
      )}
    </ViewSidebar>
  );
}

function runMark(run: AutomationRun): ReactNode {
  if (run.status === "running") return <Spinner />;
  return runNeedsAttention(run) ? (
    <Icon icon={WarningIcon} size={16} label="Needs a look" />
  ) : (
    <Icon icon={CheckIcon} size={16} label="Finished" />
  );
}

function Section(props: { label: string; children: ReactNode }) {
  return (
    <section aria-label={props.label}>
      <h3 className="px-2.5 pt-3 pb-1.5 text-[11.5px] font-medium tracking-[0.01em] text-subtle-foreground">
        {props.label}
      </h3>
      <ul className="flex flex-col gap-px">{props.children}</ul>
    </section>
  );
}

function Row(props: {
  to: string;
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  trailing: string | undefined;
}) {
  return (
    <li>
      <Link
        to="/automations/$automationId"
        params={{ automationId: props.to }}
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2.5 rounded-[10px] px-[11px] py-[9px] outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent",
          props.selected && "bg-selected",
        )}
      >
        <span className="mt-px grid size-[26px] place-items-center rounded-sm bg-secondary text-muted-foreground">
          {props.icon}
        </span>
        <span className="min-w-0">
          <span className="block text-ui leading-[1.3] font-medium text-foreground">
            {props.title}
          </span>
          <span className="mt-0.5 line-clamp-2 text-[12px] leading-[1.35] text-subtle-foreground">
            {props.description}
          </span>
        </span>
        <span className="self-end text-xs text-subtle-foreground tabular-nums">
          {props.trailing}
        </span>
      </Link>
    </li>
  );
}
