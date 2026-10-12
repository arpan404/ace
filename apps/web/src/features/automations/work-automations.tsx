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
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useNow } from "@/lib/time.ts";
import type { AutomationEntry } from "./automations-source.ts";
import { NextRun } from "./automation-next-run.tsx";
import { describeWhen, localTimeZone } from "./schedule.ts";
import { useAutomationActions, useAutomations } from "./use-automations.ts";

/** Project schedules use the same query, writes and next-run wording as Automations. */
export function WorkAutomations(props: {
  workspaceId: string;
  workspacePath?: string | undefined;
  onClose(): void;
}) {
  const query = useAutomations();
  const navigate = useNavigate();
  const entries = query.data?.filter(
    ({ automation }) =>
      automation.trigger.kind === "schedule" &&
      (automation.workspace === props.workspaceId || automation.workspace === props.workspacePath),
  );
  return (
    <section aria-label="Automations" className="py-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <h3 className="text-xs text-subtle-foreground">Automations</h3>
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
      {query.isError ? (
        <button
          type="button"
          className="focus-ring-inset w-full rounded-md px-2 py-2 text-left text-sm text-status-failed"
          onClick={() => void query.refetch()}
        >
          Couldn't read automations. Try again
        </button>
      ) : query.isPending ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Reading automations…</p>
      ) : !entries?.length ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">No scheduled tasks</p>
      ) : (
        entries.map((entry) => (
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
  return (
    <div className="py-1">
      <div className="flex min-w-0 items-center gap-1 px-2">
        <CalendarDotsIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
        <Tip label={cadence}>
          <button
            type="button"
            className="focus-ring-inset flex min-w-0 flex-1 flex-col rounded-md p-1 text-left"
            aria-label={`Open automation ${automation.title}`}
            onClick={() => {
              props.onClose();
              void navigate({
                to: "/automations/$automationId",
                params: { automationId: automation.id },
              });
            }}
          >
            <span className="w-full truncate text-sm">{automation.title}</span>
          </button>
        </Tip>
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
        <Switch
          aria-label={`Enable ${automation.title}`}
          checked={automation.enabled}
          disabled={busy || !ready}
          onCheckedChange={(enabled) =>
            void perform(
              () => actions.setEnabled(automation, enabled),
              `${enabled ? "Resumed" : "Paused"} · ${automation.title}`,
            )
          }
        />
      </div>
      <p className="ml-8 mr-2 truncate text-xs text-subtle-foreground">
        {cadence}
        {" · "}
        <NextRun automation={automation} nextRunAt={nextRunAt} now={now} running={running} />
      </p>
    </div>
  );
}
