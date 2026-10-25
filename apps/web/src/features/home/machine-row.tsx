import { Link } from "@tanstack/react-router";
import { defaultMachineIcon, MachineMark } from "@/components/ui/machine-label.tsx";
import { machineStatus } from "@/lib/machine-status.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { machineRow, useMachineThread } from "@/lib/machine-threads.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { SettledRow } from "./settled-row.tsx";
import { ThreadRow } from "./thread-row.tsx";

/**
 * A row of the Home list for another machine's thread (ADR 0100), under that machine's client so
 * its project, status and card read as they do there. While the machine isn't connected the row
 * says so instead of a status: the last status heard may no longer hold.
 */
export function MachineRow(props: { id: string; settled: boolean; leaving: boolean }) {
  const ref = machineRow(props.id);
  const machine = useMachines().find((each) => each.id === ref?.hostId);
  if (!ref || !machine) return null;
  const mark = {
    id: machine.id,
    name: machine.name,
    icon: machine.icon ?? defaultMachineIcon(false),
  };
  return (
    <MachineScope
      machine={machine}
      unavailable={<AwayRow machine={machine} threadKey={ref.key} threadId={ref.threadId} />}
    >
      {props.settled ? (
        <SettledRow
          threadId={ref.threadId}
          rowId={props.id}
          leaving={props.leaving}
          machine={mark}
        />
      ) : (
        <ThreadRow
          threadId={ref.threadId}
          rowId={props.id}
          settled={false}
          leaving={props.leaving}
          machine={mark}
        />
      )}
    </MachineScope>
  );
}

function AwayRow(props: { machine: Machine; threadKey: string; threadId: string }) {
  const entry = useMachineThread(props.threadKey);
  if (!entry) return null;
  const status = machineStatus[props.machine.status].label;
  return (
    <Link
      {...threadOn(props.machine.id, props.threadId)}
      data-row-focus=""
      draggable={false}
      aria-label={`${entry.title}. ${props.machine.name}, ${status}`}
      className="flex h-[80px] w-full flex-col justify-center gap-1 rounded-md px-3 py-2.5 text-left text-ui outline-none focus-ring-inset hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-meta leading-4 text-muted-foreground">
        <MachineMark icon={props.machine.icon} primary={false} />
        <span className="min-w-0 flex-1 truncate">{props.machine.name}</span>
        <span className="shrink-0">{status}</span>
      </span>
      <span className="min-w-0 truncate text-md leading-5 font-medium text-muted-foreground">
        {entry.title}
      </span>
    </Link>
  );
}
