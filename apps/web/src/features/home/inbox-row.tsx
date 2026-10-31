import { currentAttention } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { defaultMachineIcon } from "@/components/ui/machine-label.tsx";
import { cn } from "@/lib/cn.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { machineRow } from "@/lib/machine-threads.ts";
import { useMachines } from "@/lib/machines.ts";
import { ProjectMark, RowContext, RowStatus, threadDetails, titleTone } from "./row-parts.tsx";
import { useOpenHere, type RowMachine } from "./thread-row.tsx";
import { useThreadCard } from "./use-thread-card.ts";

/**
 * One Inbox row: a task row's two lines (title and status word; project, branch, PR) with a
 * small dot while the person hasn't seen it. It only opens its thread: answering, approving
 * and marking read happen in the thread itself. Another machine's thread reads under that
 * machine's client and opens there.
 */
export function InboxRow(props: { id: string; onOpen(): void }) {
  const ref = machineRow(props.id);
  const machine = useMachines().find((each) => each.id === ref?.hostId);
  if (!ref) return <InboxLink threadId={props.id} onOpen={props.onOpen} />;
  if (!machine) return null;
  const mark = {
    id: machine.id,
    name: machine.name,
    icon: machine.icon ?? defaultMachineIcon(false),
  };
  return (
    <MachineScope machine={machine}>
      <InboxLink threadId={ref.threadId} machine={mark} onOpen={props.onOpen} />
    </MachineScope>
  );
}

function InboxLink(props: { threadId: string; machine?: RowMachine | undefined; onOpen(): void }) {
  const { machine } = props;
  const data = useThreadCard(props.threadId, false);
  const current = useOpenHere(props.threadId, machine?.id);
  if (!data) return null;
  const { entry } = data;
  const card = machine
    ? { ...data.card, machine: machine.name, machineIcon: machine.icon }
    : data.card;
  const attention = currentAttention(card.attention, current);
  return (
    <Link
      {...threadOn(machine?.id, entry.id)}
      onClick={props.onOpen}
      data-inbox-row=""
      aria-label={`${card.title}${card.announceUnread ? ", unread" : ""}. ${threadDetails(card).join(", ")}`}
      className={cn(
        "relative flex h-[52px] w-full flex-col justify-center gap-0.5 rounded-md px-2.5 py-[7px] text-left text-ui outline-none transition-colors duration-(--motion-fast) focus-ring-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        current ? "bg-active" : "hover:bg-hover",
      )}
    >
      {card.flags.unread && (
        <span
          aria-hidden
          data-unread-dot=""
          className="pointer-events-none absolute top-[15px] left-0.5 size-1.5 rounded-full bg-status-done"
        />
      )}
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("min-w-0 flex-1 truncate text-md leading-5", titleTone(attention))}>
          {card.title}
        </span>
        <RowStatus card={card} attention={attention} />
      </span>
      <RowContext card={card} project={<ProjectMark id={entry.workspaceId} badge={card.badge} />} />
    </Link>
  );
}
