import { useSidebarThread } from "@ace/client-react";
import { Screen } from "@/features/shell/index.ts";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { useMachines } from "@/lib/machines.ts";
import { ParentCrumbLink } from "../header/thread-crumb.tsx";
import { ThreadView } from "../thread-view.tsx";

/**
 * A thread ace delegated to another machine, shown as its parent's subagent: the child's own
 * thread, read live from the machine it runs on, under `parent / child` in the header. The
 * parent's title and link are read here, on the parent's machine, before the view moves to the
 * child's. A machine this window can't reach says so; nothing falls back to another.
 */
export function DelegatedElsewhereView(props: {
  parentThreadId: string;
  threadId: string;
  /** The host id of the machine the child runs on. */
  machine: string;
}) {
  const parent = useSidebarThread(props.parentThreadId);
  const search = useMachineSearch();
  const crumb = (
    <ParentCrumbLink
      threadId={props.parentThreadId}
      title={parent?.title ?? "Parent thread"}
      search={search}
    />
  );
  const machine = useMachines().find((each) => each.id === props.machine);
  const away = (text: string) => (
    <Screen title="Subagent" crumb={crumb}>
      <p role="status" className="px-5 py-6 text-ui text-muted-foreground">
        {text}
      </p>
    </Screen>
  );
  if (!machine) return away("This window isn't paired with the machine this subagent runs on.");
  return (
    <MachineScope
      key={machine.id}
      machine={machine}
      unavailable={away(
        machine.status === "connecting"
          ? `Connecting to ${machine.name}…`
          : `${machine.name} isn't connected. This subagent shows here when it's back.`,
      )}
    >
      <ThreadView threadId={props.threadId} crumb={crumb} />
    </MachineScope>
  );
}
