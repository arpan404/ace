import type { AutomationEntry } from "./automations-source.ts";
import { ClockIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useConnectionState } from "@ace/client-react";
import { useEffect, useId, useRef, useState } from "react";
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
import { useLayout } from "@/lib/layout.tsx";
import { runSummary, runsOn } from "./labels.ts";
import { NextRun } from "./automation-next-run.tsx";
import { RecentRuns } from "./recent-runs.tsx";
import { describeWhen, localTimeZone } from "./schedule.ts";
import { useAutomation, useAutomationActions, useAutomations } from "./use-automations.ts";
import { PollError } from "./poll-error.tsx";
import { TriggerError } from "./trigger-error.tsx";
import { useProjectName } from "@/lib/projects.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import {
  clearRunIntent,
  ensureRunIntent,
  getRunIntent,
  normalizeDaemonKey,
} from "./run-intents.ts";
import { staleDeleteMessage, staleWriteMessage } from "./revision-conflicts.ts";

/** One automation: what it does, where it runs, when next, and its recent runs. */
export function AutomationScreen(props: { id: string }) {
  const { entry, pending, error, retry } = useAutomation(props.id);
  const { url } = useDaemonConnection();
  const daemonKey = normalizeDaemonKey(url);
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
  return (
    <DetailBody key={`${daemonKey}:${entry.automation.id}`} entry={entry} daemonKey={daemonKey} />
  );
}

function DetailBody(props: { entry: AutomationEntry; daemonKey: string }) {
  const { entry, daemonKey } = props;
  const navigate = useNavigate();
  const { retry } = useAutomation(props.entry.automation.id);
  const actions = useDetailControls(entry, daemonKey, retry);
  const choices = useModelChoices();
  const now = useNow();
  const projectName = useProjectName();
  const [running] = useDaemonSetting("automations.enabled");
  const switchId = useId();
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
          <MenuItem disabled={actions.busy || !actions.ready} onClick={actions.duplicate}>
            Duplicate
          </MenuItem>
          <MenuItem
            danger
            disabled={actions.busy || !actions.ready}
            icon={<Icon icon={TrashIcon} />}
            onClick={actions.remove}
          >
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
              {!actions.ready || !automation.enabled || running === false ? (
                <Tip
                  label={
                    !actions.ready
                      ? "Reconnect to run this automation"
                      : !automation.enabled
                        ? "Resume this automation to run it"
                        : "Automations are off on this machine"
                  }
                >
                  <Button variant="primary" size="sm" disabled focusableWhenDisabled>
                    <Icon icon={PlayIcon} size={14} />
                    Run now
                  </Button>
                </Tip>
              ) : actions.pendingIntent ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={actions.startRun}
                  disabled={actions.busy}
                >
                  <Icon icon={PlayIcon} size={14} />
                  Retry run
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={actions.startRun}
                  disabled={actions.busy}
                >
                  <Icon icon={PlayIcon} size={14} />
                  Run now
                </Button>
              )}
            </div>
            {actions.runError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {actions.runError}
              </p>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor={switchId} className="text-sm text-muted-foreground">
              {automation.enabled ? "Enabled" : "Paused"}
            </label>
            <Switch
              id={switchId}
              checked={automation.enabled}
              disabled={actions.busy || !actions.ready}
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
        {entry.triggerError ? (
          <TriggerError
            trigger={automation.trigger}
            error={entry.triggerError}
            revision={entry.revision}
            automationId={automation.id}
            busy={actions.busy}
            onRetried={retry}
          />
        ) : (
          entry.lastPollError && <PollError error={entry.lastPollError} />
        )}
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

function useDetailControls(entry: AutomationEntry, daemonKey: string, refetch: () => void) {
  const { storage } = useLayout();
  const navigate = useNavigate();
  const router = useRouter();
  const ready = useConnectionState() === "ready";
  const { setEnabled, remove, runNow, save } = useAutomationActions();
  const list = useAutomations().data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  const automationId = entry.automation.id;
  const [runError, setRunError] = useState<string | undefined>();
  const [pendingIntent, setPendingIntent] = useState(() =>
    getRunIntent(storage, daemonKey, automationId),
  );
  const failed = (error: unknown) =>
    toast.error({
      title:
        error instanceof Error
          ? error.message
          : "Couldn't connect. Try again once the connection is back.",
    });

  const guard = () => {
    if (busyRef.current || !ready) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  };
  const release = () => {
    busyRef.current = false;
    if (liveRef.current) setBusy(false);
  };

  const startRun = () => {
    if (!guard()) return;
    const intent = ensureRunIntent(
      storage,
      daemonKey,
      automationId,
      () => Date.now(),
      () => crypto.randomUUID(),
    );
    if (!intent) {
      release();
      if (liveRef.current) setRunError("Couldn't save the run request. Try again.");
      return;
    }
    if (liveRef.current) {
      setPendingIntent(intent);
      setRunError(undefined);
    }
    runNow(automationId, intent.requestId).then(
      (run) => {
        clearRunIntent(storage, daemonKey, automationId);
        if (!liveRef.current) {
          release();
          return;
        }
        setPendingIntent(undefined);
        release();
        if (run.status !== "running") setRunError(runSummary(run));
        refetch();
      },
      (error: unknown) => {
        release();
        if (!liveRef.current) return;
        setPendingIntent(getRunIntent(storage, daemonKey, automationId));
        setRunError(
          error instanceof Error
            ? error.message
            : "Couldn't start the run. Retry with the same request.",
        );
        refetch();
      },
    );
  };

  return {
    busy,
    ready,
    pendingIntent,
    runError,
    startRun,
    toggle(enabled: boolean) {
      if (!guard()) return;
      setEnabled(automationId, enabled, entry.revision)
        .then(() => refetch())
        .catch((error: unknown) => {
          if (liveRef.current) failed(new Error(staleWriteMessage(error)));
          refetch();
        })
        .finally(release);
    },
    duplicate() {
      if (!guard()) return;
      const copy = {
        ...entry.automation,
        id: `auto-${crypto.randomUUID()}`,
        title: `${entry.automation.title.slice(0, 251)} copy`,
        enabled: false,
      };
      save(copy, null).then(
        () => {
          if (!liveRef.current) {
            release();
            return;
          }
          release();
          void navigate({
            to: "/automations/$automationId/edit",
            params: { automationId: copy.id },
          });
        },
        (error: unknown) => {
          release();
          if (liveRef.current) failed(new Error(staleWriteMessage(error)));
        },
      );
    },
    remove() {
      if (!guard()) return;
      const { automation, revision } = entry;
      const ids = (list ?? []).map((candidate) => candidate.automation.id);
      const at = ids.indexOf(automation.id);
      const next = ids[at + 1] ?? ids[at - 1];
      remove(automation.id, revision).then(
        () => {
          clearRunIntent(storage, daemonKey, automation.id);
          release();
          toast.add({
            title: `Deleted · ${automation.title}`,
            undo: () => {
              save(automation, null).then(
                () => refetch(),
                (error: unknown) => failed(new Error(staleWriteMessage(error))),
              );
            },
          });
          if (
            router.state.location.pathname !== `/automations/${encodeURIComponent(automation.id)}`
          )
            return;
          void navigate(
            next && next !== automation.id
              ? { to: "/automations/$automationId", params: { automationId: next } }
              : { to: "/automations" },
          );
        },
        (error: unknown) => {
          release();
          if (!liveRef.current) return;
          failed(new Error(staleDeleteMessage(error)));
          refetch();
        },
      );
    },
  };
}
