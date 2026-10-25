import type { ThreadListEntry } from "@ace/protocol";
import {
  ArchiveIcon,
  FolderSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRef } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MenuItem, MenuLabel, MenuGroup, MenuSeparator } from "@/components/ui/menu.tsx";
import { machineRow } from "@/lib/machine-threads.ts";
import {
  useHomeSelection,
  useHomeSelectionState,
  useThreadMover,
  useWindowThreads,
  type HomeSelection,
  type WindowThreads,
} from "@/features/organize/index.ts";

/*
 * Bulk actions on the picked Home threads: the bar under the list, the context menu of a picked
 * row and the palette all offer Pin or Unpin, Move to project, Archive and Delete. Move asks
 * which project; Delete asks first. Move and Archive act at once and offer one Undo for all,
 * while Delete is permanent (no Undo). Loaded once something is picked. Picked rows may be on
 * several machines (ADR 0100): each action runs on each row's own machine. A project belongs to
 * one machine, so Move shows only while every picked row is on the same one.
 */

/** The picked threads as this window shows them (with organize actions not yet confirmed). */
function usePicked(threads: WindowThreads): ThreadListEntry[] {
  const { ids } = useHomeSelectionState();
  return ids.flatMap((id) => {
    const entry = threads.entry(id);
    return entry ? [entry] : [];
  });
}

/**
 * Ask which project the picked rows move to, on the machine they are all on; undefined when they
 * are on more than one. The picker runs on that machine, so it gets the ids that machine knows.
 */
function moveOf(entries: readonly ThreadListEntry[], threads: WindowThreads) {
  const hosts = new Set(entries.map((entry) => threads.hostOf(entry.id)));
  if (hosts.size !== 1) return undefined;
  const [hostId] = hosts;
  return {
    entries: entries.map((entry) => ({ ...entry, id: machineRow(entry.id)?.threadId ?? entry.id })),
    ...(hostId ? { hostId } : {}),
  };
}

const count = (n: number) => (n === 1 ? "1 thread" : `${n} threads`);

/** Unpin when every picked thread is pinned; otherwise Pin pins the rest. */
const allPinned = (entries: readonly ThreadListEntry[]) =>
  entries.length > 0 && entries.every((entry) => entry.pinned === true);

/** The picked-thread actions, in the order every surface lists them. */
function bulkActions(
  entries: readonly ThreadListEntry[],
  selection: HomeSelection,
  threads: WindowThreads,
  mover: ReturnType<typeof useThreadMover>,
) {
  const { actions } = threads;
  const unpin = allPinned(entries);
  const move = moveOf(entries, threads);
  const list = [
    {
      id: "pin",
      label: unpin ? `Unpin ${count(entries.length)}` : `Pin ${count(entries.length)}`,
      icon: unpin ? PushPinSlashIcon : PushPinIcon,
      danger: false,
      run: () => {
        actions.setPinnedMany(entries, !unpin);
        selection.clear();
      },
    },
    {
      id: "move",
      label: `Move ${count(entries.length)} to project…`,
      icon: FolderSimpleIcon,
      danger: false,
      run: () => move && mover.open({ ...move, onMoved: () => selection.clear() }),
    },
    {
      id: "archive",
      label: `Archive ${count(entries.length)}`,
      icon: ArchiveIcon,
      danger: false,
      run: () => {
        actions.archiveMany(entries);
        selection.clear();
      },
    },
    {
      id: "delete",
      label: `Delete ${count(entries.length)}…`,
      icon: TrashIcon,
      danger: true,
      run: () => selection.ask("delete"),
    },
  ];
  return move ? list : list.filter((action) => action.id !== "move");
}

/** Under the list while threads are picked: how many, what to do with them, and Clear. */
export function BulkBar() {
  const selection = useHomeSelection();
  const threads = useWindowThreads();
  const mover = useThreadMover();
  const entries = usePicked(threads);
  if (!entries.length) return null;
  return (
    <>
      <div
        role="toolbar"
        aria-label="Selected threads"
        className="ace-floating mx-2 mb-2 flex items-center gap-0.5 rounded-lg py-1 pr-1 pl-3 text-ui"
      >
        <span className="mr-auto font-medium whitespace-nowrap tabular-nums" aria-live="polite">
          {entries.length} selected
        </span>
        {bulkActions(entries, selection, threads, mover).map((action) => (
          <IconButton
            key={action.id}
            icon={action.icon}
            label={action.label}
            className={action.danger ? "text-destructive" : undefined}
            onClick={action.run}
          />
        ))}
        <IconButton
          icon={XIcon}
          label="Clear selection"
          className="ml-1"
          onClick={() => selection.clear()}
        />
      </div>
      <BulkConfirmDialog entries={entries} />
    </>
  );
}

/** For a picked row's context menu: the bulk actions in place of the row's own. */
export function BulkMenuItems() {
  const selection = useHomeSelection();
  const threads = useWindowThreads();
  const mover = useThreadMover();
  const entries = usePicked(threads);
  const list = bulkActions(entries, selection, threads, mover);
  return (
    <>
      <MenuGroup>
        <MenuLabel>{count(entries.length)} selected</MenuLabel>
        {list.map((action) => (
          <MenuItem
            key={action.id}
            icon={<Icon icon={action.icon} />}
            {...(action.danger ? { danger: true } : {})}
            onClick={action.run}
          >
            {action.label}
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem icon={<Icon icon={XIcon} />} onClick={() => selection.clear()}>
        Clear selection
      </MenuItem>
    </>
  );
}

/** The question before deleting the picked threads, which can't be undone; Cancel has focus. */
function BulkConfirmDialog(props: { entries: readonly ThreadListEntry[] }) {
  const selection = useHomeSelection();
  const { confirm } = useHomeSelectionState();
  const { actions } = useWindowThreads();
  const cancel = useRef<HTMLButtonElement>(null);
  const n = props.entries.length;
  const shown = props.entries.slice(0, 5);
  const go = () => {
    actions.removeMany(props.entries);
    selection.clear();
  };
  return (
    <Dialog open={confirm !== undefined} onOpenChange={(open) => !open && selection.ask(undefined)}>
      <DialogContent initialFocus={cancel} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete {count(n)}?</DialogTitle>
          <DialogDescription>
            They are deleted for good, on every device. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {shown.map((entry) => (
            <li key={entry.id} className="truncate">
              {entry.title}
            </li>
          ))}
          {n > shown.length && <li>and {count(n - shown.length)} more</li>}
        </ul>
        <DialogFooter>
          <Button ref={cancel} variant="ghost" onClick={() => selection.ask(undefined)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={go}>
            Delete {count(n)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
