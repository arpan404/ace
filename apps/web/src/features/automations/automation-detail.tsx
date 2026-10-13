import type { Automation } from "@ace/protocol";
import { ClockIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useId } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingCard, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useModelChoices } from "@/features/models/index.ts";
import { Page, Screen } from "@/features/shell/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNow } from "@/lib/time.ts";
import { runsOn } from "./labels.ts";
import { NextRun } from "./automation-next-run.tsx";
import { RecentRuns } from "./recent-runs.tsx";
import { describeWhen, localTimeZone } from "./schedule.ts";
import {
  undoWindowMs,
  useAutomation,
  useAutomationActions,
  useAutomations,
} from "./use-automations.ts";
import { PollError } from "./poll-error.tsx";
import { useProjectName } from "@/lib/projects.ts";

/** One automation: what it does, where it runs, when next, and its recent runs. */
export function AutomationScreen(props: { id: string }) {
  const navigate = useNavigate();
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
                ? "Couldn't connect. This loads again when the connection is back."
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
  return (
    <Screen
      title="Automations"
      menu={
        <>
          <MenuItem
            onClick={() =>
              void navigate({
                to: "/automations/$automationId/edit",
                params: { automationId: automation.id },
              })
            }
          >
            Edit
          </MenuItem>
          <MenuItem onClick={actions.duplicate}>Duplicate</MenuItem>
          <MenuItem danger icon={<Icon icon={TrashIcon} />} onClick={actions.remove}>
            Delete
          </MenuItem>
        </>
      }
    >
      <Page>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-semibold tracking-title">{automation.title}</h2>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-base text-muted-foreground">
                {projectName(automation.workspace)}
              </span>
              {/* A paused automation must resume before it can run. */}
              {!automation.enabled || running === false ? (
                <Tip
                  label={
                    !automation.enabled
                      ? "Resume this automation to run it"
                      : "Automations are off on this machine"
                  }
                >
                  <Button variant="primary" size="sm" disabled focusableWhenDisabled>
                    <Icon icon={PlayIcon} size={14} />
                    Run now
                  </Button>
                </Tip>
              ) : (
                <Button variant="primary" size="sm" onClick={actions.runNow}>
                  <Icon icon={PlayIcon} size={14} />
                  Run now
                </Button>
              )}
            </div>
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
          <section aria-label="Prompt" className="mb-5">
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Prompt</h2>
            <p className="text-base leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {automation.prompt}
            </p>
          </section>
          <SettingCard>
            <SettingRow
              title="When"
              description={
                <>
                  {describeWhen(automation.trigger, localTimeZone())} ·{" "}
                  <NextRun
                    automation={automation}
                    nextRunAt={nextRunAt}
                    now={now}
                    running={running}
                  />
                </>
              }
            />
            <SettingRow title="Runs on" description={runsOn(automation, choices)} />
          </SettingCard>
        </div>
        {entry.lastPollError && <PollError error={entry.lastPollError} />}
        <RecentRuns
          automationId={automation.id}
          timezone={
            automation.trigger.kind === "schedule"
              ? automation.trigger.schedule.timezone
              : undefined
          }
        />
      </Page>
    </Screen>
  );
}

function useAutomationControls(automation: Automation | undefined) {
  const navigate = useNavigate();
  const { setEnabled, remove, runNow, setHidden, save } = useAutomationActions();
  const list = useAutomations().data;
  const toast = useToast();
  const failed = (error: unknown) =>
    toast.error({
      title:
        error instanceof Error
          ? error.message
          : "Couldn't connect. Try again once the connection is back.",
    });
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
    duplicate() {
      if (!automation) return;
      const copy = {
        ...automation,
        id: `auto-${crypto.randomUUID()}`,
        title: `${automation.title.slice(0, 251)} copy`,
        enabled: false,
      };
      save(copy).then(
        () =>
          navigate({ to: "/automations/$automationId/edit", params: { automationId: copy.id } }),
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
