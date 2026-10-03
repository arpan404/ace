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
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNow } from "@/lib/time.ts";
import { missedRunLabels, runsOn } from "./labels.ts";
import { RecentRuns } from "./recent-runs.tsx";
import { describeTrigger, formatNextRun } from "./schedule.ts";
import { useAutomation, useAutomationActions } from "./use-automations.ts";
import { useProjectName } from "@/lib/projects.ts";

/** One automation: what it does, where it runs, when next, and its recent runs. */
export function AutomationScreen(props: { id: string }) {
  const { entry, pending, error } = useAutomation(props.id);
  const actions = useAutomationControls(entry?.automation);
  const choices = useModelChoices();
  const now = useNow();
  const projectName = useProjectName();
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
              {describeTrigger(automation.trigger)} · {projectName(automation.workspace)}
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
          <SettingRow
            title="Next run"
            description={<NextRun automation={automation} nextRunAt={nextRunAt} now={now} />}
          >
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

/**
 * When it runs next. With automations off on the daemon's machine nothing runs, so it says so
 * and links to the setting; a schedule the daemon hasn't placed yet says that, not a guess.
 */
function NextRun(props: { automation: Automation; nextRunAt: number | undefined; now: number }) {
  const { automation, nextRunAt } = props;
  const [running] = useDaemonSetting("automations.enabled");
  if (!automation.enabled) return "Paused. Resume to schedule the next run.";
  if (running === false)
    return (
      <>
        Automations are off on this machine.{" "}
        <Link to="/settings/general" className="text-foreground underline-offset-4 hover:underline">
          Turn on Run automations
        </Link>
      </>
    );
  if (nextRunAt !== undefined) return formatNextRun(nextRunAt, props.now);
  switch (automation.trigger.kind) {
    case "github":
      return "On the next matching event";
    case "file":
      return "On the next change";
    case "manual":
      return "Only when you run it";
    case "schedule":
      return "Not scheduled yet";
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
  const failed = (error: unknown) =>
    toast.add({ title: error instanceof Error ? error.message : "The daemon didn't answer." });
  return {
    toggle(enabled: boolean) {
      if (!automation) return;
      setEnabled(automation, enabled).then(
        () => toast.add({ title: `${enabled ? "Resumed" : "Paused"} · ${automation.title}` }),
        failed,
      );
    },
    runNow() {
      if (!automation) return;
      runNow(automation.id).then(
        () => toast.add({ title: `Started · ${automation.title}` }),
        failed,
      );
    },
    remove() {
      if (!automation) return;
      remove(automation.id).then(() => {
        void navigate({ to: "/automations" });
        toast.add({
          title: `Deleted · ${automation.title}`,
          actionProps: { children: "Undo", onClick: () => void save(automation).catch(failed) },
        });
      }, failed);
    },
  };
}
