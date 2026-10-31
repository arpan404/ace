import { Link } from "@tanstack/react-router";
import { defaultMachineIcon } from "@/components/ui/machine-label.tsx";
import { machineStatus } from "@/lib/machine-status.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { machineRow, useMachineThread } from "@/lib/machine-threads.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { RecentlySettledRow } from "./settled-row.tsx";
import { ThreadRow, type RowLead } from "./thread-row.tsx";

/**
 * A row of the Home list for another machine's thread (ADR 0102), under that machine's client so
 * its project, status and card read as they do there. While the machine isn't connected the row
 * is muted with no mark, and its name says so: the last status heard may no longer hold.
 */
export function MachineRow(props: {
  id: string;
  leaving: boolean;
  /** A task row, or a recently settled row in its project. */
  shape: "task" | "recently-settled";
  lead: RowLead;
}) {
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
      {props.shape === "recently-settled" ? (
        <RecentlySettledRow
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
          lead={props.lead}
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
      className="flex h-(--row-height) w-full items-center gap-2.5 rounded-md px-2.5 text-left text-md outline-none focus-ring-inset hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span aria-hidden className="w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.title}</span>
    </Link>
  );
}
