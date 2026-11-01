import type { ThreadListEntry } from "@ace/protocol";
import type { ThreadRowFlags } from "@ace/ui-core";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { threadActions, useThreadActions, useThreadMover } from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { useScopedMachine } from "@/lib/machines.ts";

/** A chat's hover actions: the thread menus' own, in their order. */
const shownIds: ReadonlySet<string> = new Set(["rename", "pin", "move", "delete"]);
const noFork = { point: undefined, onFork: () => {} };

/**
 * A chat row's hover and focus actions, in its mark's place at its right edge: Rename, Pin (or
 * Unpin), Move to project and Delete, each the thread menus' own action (Delete asks first). The
 * rest stays in the row's context menu.
 */
export function ChatRowActions(props: {
  entry: ThreadListEntry;
  flags: ThreadRowFlags;
  onRename(): void;
  onHover(): void;
  shown: boolean;
}) {
  const actions = useThreadActions();
  const mover = useThreadMover();
  const scoped = useScopedMachine()?.id;
  const { entry } = props;
  const list = threadActions(entry, props.flags, actions, {
    onRename: props.onRename,
    fork: noFork,
    onMove: () => mover.open({ entries: [entry], ...(scoped ? { hostId: scoped } : {}) }),
  }).filter((action) => shownIds.has(action.id) && !action.disabled);
  return (
    <div
      // Centred on the row's one line, so the row never moves.
      className={cn(
        "absolute top-1/2 right-1.5 -translate-y-1/2 items-center gap-0.5",
        props.shown ? "flex" : "hidden has-[[data-popup-open]]:flex",
      )}
      role="presentation"
      onPointerEnter={props.onHover}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {list.map((action) => (
        <IconButton
          key={action.id}
          icon={action.icon}
          size="sm"
          label={`${action.label.replace(/…$/, "")} ${entry.title}`}
          tip={action.label.replace(/…$/, "")}
          tabIndex={-1}
          onClick={action.run}
        />
      ))}
    </div>
  );
}
