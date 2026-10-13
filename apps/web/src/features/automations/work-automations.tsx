import { useConnectionState } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDotsIcon,
  PencilSimpleIcon,
  PlayIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { plainRow } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNow } from "@/lib/time.ts";
import type { AutomationEntry } from "./automations-source.ts";
import { NextRun } from "./automation-next-run.tsx";
import { describeWhen, localTimeZone } from "./schedule.ts";
import { useAutomationActions, useAutomations } from "./use-automations.ts";

/**
 * The project's schedules, read with the same query as Automations: `entries` once read,
 * `failed` when the read failed (with `retry`). Undefined entries while it reads.
 */
export function useProjectAutomations(workspaceId: string, workspacePath: string | undefined) {
  const query = useAutomations();
  const entries = query.data?.filter(
    ({ automation }) =>
      automation.trigger.kind === "schedule" &&
      (automation.workspace === workspaceId || automation.workspace === workspacePath),
  );
  return { entries, failed: query.isError, retry: () => void query.refetch() };
}

/**
 * Project schedules use the same query, writes and next-run wording as Automations. A project
 * with none shows nothing at all; the section's settings icon opens Automations.
 */
export function WorkAutomations(props: {
  automations: ReturnType<typeof useProjectAutomations>;
  onClose(): void;
}) {
  const navigate = useNavigate();
  const { entries, failed, retry } = props.automations;
  if (!failed && !entries?.length) return null;
  return (
    <section aria-label="Automations">
      <div className="flex h-7 items-center justify-between pr-1 pl-2">
        <h3 className="text-xs text-muted-foreground">Automations</h3>
        <IconButton
          icon={SlidersHorizontalIcon}
          label="Automation settings"
          size="sm"
          onClick={() => {
            props.onClose();
            void navigate({ to: "/automations" });
          }}
        />
      </div>
      {failed ? (
        <button
          type="button"
          className="focus-ring-inset flex h-8 w-full items-center rounded-md px-2 text-left text-ui text-status-failed"
          onClick={retry}
        >
          Couldn't read automations. Try again
        </button>
      ) : (
        entries?.map((entry) => (
          <AutomationLine key={entry.automation.id} entry={entry} onClose={props.onClose} />
        ))
      )}
    </section>
  );
}

function AutomationLine(props: { entry: AutomationEntry; onClose(): void }) {
  const { automation, nextRunAt } = props.entry;
  const actions = useAutomationActions();
  const navigate = useNavigate();
  const toast = useToast();
  const now = useNow();
  const [running] = useDaemonSetting("automations.enabled");
  const ready = useConnectionState() === "ready";
  const [busy, setBusy] = useState(false);
  const perform = async (write: () => Promise<unknown>, done: string) => {
    if (busy || !ready) return;
    setBusy(true);
    try {
      await write();
      toast.add({ title: done });
    } catch {
      toast.error({
        title: "Couldn't update this automation. Try again",
      });
    } finally {
      setBusy(false);
    }
  };
  const runBlocked = !ready
    ? "Reconnect to run this automation"
    : !automation.enabled
      ? "Resume this automation to run it"
      : running === false
        ? "Automations are off on this machine"
        : undefined;
  const cadence = describeWhen(automation.trigger, localTimeZone());
  // One plain row like Summary's agents: the title over its schedule and when it next runs, its
  // toggle, and Edit and Run on hover or focus (always on touch, with no hover).
  return (
    <div
      className={cn(
        "group/automation flex min-h-11 min-w-0 items-center gap-1 pr-1.5 pl-2",
        plainRow,
      )}
    >
      <CalendarDotsIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
      <Tip label={cadence}>
        <button
          type="button"
          className="focus-ring-inset flex min-w-0 flex-1 flex-col items-start rounded-sm px-1.5 py-1 text-left text-ui"
          aria-label={`Open automation ${automation.title}`}
          onClick={() => {
            props.onClose();
            void navigate({
              to: "/automations/$automationId",
              params: { automationId: automation.id },
            });
          }}
        >
          <span className="max-w-full min-w-0 truncate font-medium">{automation.title}</span>
          <span className="max-w-full min-w-0 truncate text-xs text-muted-foreground">
            {cadence} ·{" "}
            <NextRun automation={automation} nextRunAt={nextRunAt} now={now} running={running} />
          </span>
        </button>
      </Tip>
      <span className="hidden shrink-0 items-center group-focus-within/automation:flex group-hover/automation:flex pointer-coarse:flex">
        <IconButton
          icon={PencilSimpleIcon}
          label={`Edit ${automation.title}`}
          size="sm"
          onClick={() => {
            props.onClose();
            void navigate({
              to: "/automations/$automationId/edit",
              params: { automationId: automation.id },
            });
          }}
        />
        <IconButton
          icon={PlayIcon}
          label={runBlocked ?? `Run ${automation.title} now`}
          size="sm"
          disabled={busy || !!runBlocked}
          onClick={() =>
            void perform(() => actions.runNow(automation.id), `Started · ${automation.title}`)
          }
        />
      </span>
      <Switch
        aria-label={`Enable ${automation.title}`}
        checked={automation.enabled}
        disabled={busy || !ready}
        className="ml-1"
        onCheckedChange={(enabled) =>
          void perform(
            () => actions.setEnabled(automation, enabled),
            `${enabled ? "Resumed" : "Paused"} · ${automation.title}`,
          )
        }
      />
    </div>
  );
}
