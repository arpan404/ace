import type { Automation } from "@ace/protocol";
import { ClockIcon, PauseIcon, PencilSimpleIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useModelChoices } from "@/features/models/index.ts";
import { Page, Screen } from "@/features/shell/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNow } from "@/lib/time.ts";
import { missedRunLabels, runsOn } from "./labels.ts";
import { RecentRuns } from "./recent-runs.tsx";
import { describeWhen, formatNextRun, formatRunInZone, localTimeZone } from "./schedule.ts";
import {
  undoWindowMs,
  useAutomation,
  useAutomationActions,
  useAutomations,
} from "./use-automations.ts";
import { useProjectName } from "@/lib/projects.ts";

/** One automation: what it does, where it runs, when next, and its recent runs. */
export function AutomationScreen(props: { id: string }) {
  const { entry, pending, error, retry } = useAutomation(props.id);
  const actions = useAutomationControls(entry?.automation);
  const choices = useModelChoices();
  const now = useNow();
  const projectName = useProjectName();
  const [running] = useDaemonSetting("automations.enabled");
  const switchId = useId();
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
            action={
              error ? (
                <Button size="sm" onClick={retry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        )}
      </Screen>
    );
  const { automation, nextRunAt } = entry;
  const edit = { to: "/automations/$automationId/edit", params: { automationId: automation.id } };
  return (
    <Screen
      title={automation.title}
      subtitle="Automation"
      menu={
        <>
          <MenuItem icon={<Icon icon={PencilSimpleIcon} />} render={<Link {...edit} />}>
            Edit
          </MenuItem>
          <MenuItem
            icon={<Icon icon={automation.enabled ? PauseIcon : PlayIcon} />}
            onClick={() => actions.toggle(!automation.enabled)}
          >
            {automation.enabled ? "Pause" : "Resume"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Icon icon={TrashIcon} />} onClick={actions.remove}>
            Delete
          </MenuItem>
        </>
      }
      actions={
        // A paused automation can't run (the daemon refuses): offer the step that works.
        !automation.enabled ? (
          <Button variant="ghost" size="sm" onClick={() => actions.toggle(true)}>
            <Icon icon={PlayIcon} size={14} />
            Resume
          </Button>
        ) : running === false ? (
          <Tip label="Automations are off on this machine">
            <Button variant="ghost" size="sm" disabled focusableWhenDisabled>
              <Icon icon={PlayIcon} size={14} />
              Run now
            </Button>
          </Tip>
        ) : (
          <Button variant="ghost" size="sm" onClick={actions.runNow}>
            <Icon icon={PlayIcon} size={14} />
            Run now
          </Button>
        )
      }
    >
      <Page>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-semibold tracking-title">{automation.title}</h2>
            <p className="mt-1 text-base text-muted-foreground">
              {projectName(automation.workspace)}
            </p>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor={switchId} className="text-sm text-muted-foreground">
              {automation.enabled ? "Enabled" : "Paused"}
            </label>
            <Switch
              id={switchId}
              checked={automation.enabled}
              onCheckedChange={(checked) => actions.toggle(checked)}
            />
          </div>
        </div>
        <div className="mt-7">
          <SettingRow title="Prompt" description={automation.prompt}>
            <EditLink id={automation.id} label="Edit" what="prompt" />
          </SettingRow>
          <SettingRow title="When" description={describeWhen(automation.trigger, localTimeZone())}>
            <EditLink id={automation.id} label="Change" what="when it runs" />
          </SettingRow>
          <SettingRow title="Runs on" description={runsOn(automation, choices)}>
            <EditLink id={automation.id} label="Change" what="agent" />
          </SettingRow>
          <SettingRow
            title="Next run"
            description={
              <NextRun automation={automation} nextRunAt={nextRunAt} now={now} running={running} />
            }
          />
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
function NextRun(props: {
  automation: Automation;
  nextRunAt: number | undefined;
  now: number;
  running: boolean | undefined;
}) {
  const { automation, nextRunAt } = props;
  if (!automation.enabled) return "Paused. Resume to schedule the next run.";
  if (props.running === false)
    return (
      <>
        Automations are off on this machine.{" "}
        <Link to="/settings/general" className="text-foreground underline-offset-4 hover:underline">
          Turn on Run automations
        </Link>
      </>
    );
  if (nextRunAt !== undefined) {
    const zone =
      automation.trigger.kind === "schedule" ? automation.trigger.schedule.timezone : undefined;
    const when = formatNextRun(nextRunAt, props.now);
    // Local time first; a schedule kept in another zone also says its own wall clock.
    return zone && zone !== localTimeZone()
      ? `${when} (${formatRunInZone(nextRunAt, zone)} in ${zone})`
      : when;
  }
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

function EditLink(props: { id: string; label: string; what: string }) {
  return (
    <Link
      to="/automations/$automationId/edit"
      params={{ automationId: props.id }}
      aria-label={`${props.label} ${props.what}`}
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      {props.label}
    </Link>
  );
}

function useAutomationControls(automation: Automation | undefined) {
  const { setEnabled, remove, runNow, setHidden } = useAutomationActions();
  const list = useAutomations().data;
  const toast = useToast();
  const navigate = useNavigate();
  const failed = (error: unknown) =>
    toast.error({ title: error instanceof Error ? error.message : "The daemon didn't answer." });
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
    /**
     * Hidden at once and removed on the daemon only once the Undo window closes, so Undo
     * never has to recreate it (and its run history is never at risk).
     */
    remove() {
      if (!automation) return;
      const ids = (list ?? []).map((entry) => entry.automation.id);
      const at = ids.indexOf(automation.id);
      const next = ids[at + 1] ?? ids[at - 1];
      let undone = false;
      setHidden(automation.id, true);
      void navigate(
        next && next !== automation.id
          ? { to: "/automations/$automationId", params: { automationId: next } }
          : { to: "/automations" },
      );
      const toastId = toast.add({
        title: `Deleted · ${automation.title}`,
        timeout: undoWindowMs,
        actionProps: {
          children: "Undo",
          onClick: () => {
            undone = true;
            setHidden(automation.id, false);
            toast.close(toastId);
          },
        },
        onClose: () => {
          if (undone) return;
          remove(automation.id).then(
            () => setHidden(automation.id, false),
            (error: unknown) => {
              setHidden(automation.id, false);
              failed(error);
            },
          );
        },
      });
    },
  };
}
