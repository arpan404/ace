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
import { rowCard } from "@/components/ui/rules.ts";
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
    <section aria-label="Automations" className="py-1.5">
      <div className="flex h-7 items-center justify-between pr-1 pl-2.5">
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
      {query.isError ? (
        <button
          type="button"
          className="focus-ring-inset flex h-8 w-full items-center rounded-md px-2.5 text-left text-ui text-status-failed"
          onClick={() => void query.refetch()}
        >
          Couldn't read automations. Try again
        </button>
      ) : query.isPending ? (
        <p className="flex h-8 items-center px-2.5 text-ui text-muted-foreground">
          Reading automations…
        </p>
      ) : !entries?.length ? (
        <p className="flex h-8 items-center px-2.5 text-ui text-muted-foreground">
          No scheduled tasks
        </p>
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
  // One outlined row card like Summary's agents: the title over its schedule and when it next
  // runs, its toggle, and Edit and Run on hover or focus (always on touch, with no hover).
  return (
    <div
      className={cn(
        "group/automation mb-1 flex min-h-11 min-w-0 items-center gap-1 pr-1.5 pl-2.5",
        rowCard,
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
