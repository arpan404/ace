import type { Automation } from "@ace/protocol";
import { ClockIcon, PauseIcon, PencilSimpleIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useModelChoices } from "@/features/models/index.ts";
import { Page, Screen } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { missedRunLabels, runsOn } from "./labels.ts";
import { RecentRuns } from "./recent-runs.tsx";
import { describeTrigger, formatNextRun } from "./schedule.ts";
import { useAutomation, useAutomationActions } from "./use-automations.ts";

/** One automation: what it does, where it runs, when next, and its recent runs. */
export function AutomationScreen(props: { id: string }) {
  const { entry, pending, error } = useAutomation(props.id);
  const actions = useAutomationControls(entry?.automation);
  const choices = useModelChoices();
  const now = useNow();
  if (!entry)
    return (
      <Screen title="Automation">
        {pending ? (
          <Page>
            <LoadingRegion label="automation" className="flex flex-col gap-3">
              <Skeleton className="h-6 w-72" />
              <Skeleton className="h-3.5 w-48" />
              <SkeletonText lines={4} className="mt-8" />
            </LoadingRegion>
          </Page>
        ) : (
          <EmptyState
            icon={ClockIcon}
            title={error ? "Couldn't load this automation" : "Automation not found"}
            description={
              error
                ? "The daemon didn't answer. It will be read again once the connection is back."
                : "It may have been deleted on another device."
            }
          />
        )}
      </Screen>
    );
  const { automation, nextRunAt } = entry;
  return (
    <Screen
      title={automation.title}
      subtitle="Automation"
      menu={
        <>
          <MenuItem
            icon={<Icon icon={PencilSimpleIcon} size={14} />}
            render={
              <Link to="/automations/$automationId/edit" params={{ automationId: automation.id }} />
            }
          >
            Edit
          </MenuItem>
          <MenuItem
            icon={<Icon icon={automation.enabled ? PauseIcon : PlayIcon} size={14} />}
            onClick={() => actions.toggle(!automation.enabled)}
          >
            {automation.enabled ? "Pause" : "Resume"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Icon icon={TrashIcon} size={14} />} onClick={actions.remove}>
            Delete
          </MenuItem>
        </>
      }
      actions={
        <Button variant="ghost" size="sm" onClick={actions.runNow}>
          <Icon icon={PlayIcon} size={14} />
          Run now
        </Button>
      }
    >
      <Page>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-semibold tracking-title">{automation.title}</h2>
            <p className="mt-1 text-base text-muted-foreground">
              {describeTrigger(automation.trigger)} · {automation.workspace}
            </p>
          </div>
          <Switch
            aria-label="Enabled"
            className="mt-2.5"
            checked={automation.enabled}
            onCheckedChange={(checked) => actions.toggle(checked)}
          />
        </div>
        <div className="mt-7">
          <SettingRow title="Prompt" description={automation.prompt}>
            <EditLink id={automation.id} label="Edit" />
          </SettingRow>
          <SettingRow title="Runs on" description={runsOn(automation, choices)}>
            <EditLink id={automation.id} label="Change" />
          </SettingRow>
          <SettingRow title="Next run" description={nextRunText(automation, nextRunAt, now)}>
            <Button size="sm" onClick={actions.runNow}>
              Run now
            </Button>
          </SettingRow>
          {automation.trigger.kind === "schedule" && (
            <SettingRow
              title="If a run was missed"
              description={missedRunLabels[automation.missedRun]}
            />
          )}
        </div>
        <RecentRuns automationId={automation.id} />
      </Page>
    </Screen>
  );
}

function nextRunText(automation: Automation, nextRunAt: number | undefined, now: number): string {
  if (!automation.enabled) return "Paused. Resume to schedule the next run.";
  if (nextRunAt !== undefined) return formatNextRun(nextRunAt, now);
  switch (automation.trigger.kind) {
    case "github":
      return "On the next matching event";
    case "file":
      return "On the next change";
    case "manual":
      return "Only when you run it";
    case "schedule":
      return "Calculated by the daemon";
  }
}

function EditLink(props: { id: string; label: string }) {
  return (
    <Link
      to="/automations/$automationId/edit"
      params={{ automationId: props.id }}
      aria-label={`${props.label} ${props.label === "Edit" ? "prompt" : "agent"}`}
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      {props.label}
    </Link>
  );
}

function useAutomationControls(automation: Automation | undefined) {
  const { setEnabled, remove, runNow, save } = useAutomationActions();
  const toast = useToast();
  const navigate = useNavigate();
  return {
    toggle(enabled: boolean) {
      if (!automation) return;
      void setEnabled(automation, enabled).then(() =>
        toast.add({ title: `${enabled ? "Resumed" : "Paused"} · ${automation.title}` }),
      );
    },
    runNow() {
      if (!automation) return;
      void runNow(automation.id).then(() => toast.add({ title: `Started · ${automation.title}` }));
    },
    remove() {
      if (!automation) return;
      void remove(automation.id).then(() => {
        void navigate({ to: "/automations" });
        toast.add({
          title: `Deleted · ${automation.title}`,
          actionProps: { children: "Undo", onClick: () => void save(automation) },
        });
      });
    },
  };
}
