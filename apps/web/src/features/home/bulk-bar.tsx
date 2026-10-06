import { useSidebarStore } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import {
  ArchiveIcon,
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
import {
  useHomeSelection,
  useHomeSelectionState,
  useOrganizeOverlay,
  useThreadActions,
  type BulkConfirm,
  type HomeSelection,
} from "@/features/organize/index.ts";

/*
 * Bulk actions on the picked Home threads: the bar under the list, the context menu of a picked
 * row and the palette all offer Pin or Unpin, Archive and Delete. Archive and Delete ask first,
 * then offer one Undo for all. Loaded once something is picked.
 */

/** The picked threads as this window shows them (with organize actions not yet confirmed). */
function usePicked(): ThreadListEntry[] {
  const { ids } = useHomeSelectionState();
  const store = useSidebarStore();
  const overlay = useOrganizeOverlay();
  return ids.flatMap((id) => {
    const entry = store?.thread(id);
    return entry ? [overlay.apply(entry)] : [];
  });
}

const count = (n: number) => (n === 1 ? "1 thread" : `${n} threads`);

/** Unpin when every picked thread is pinned; otherwise Pin pins the rest. */
const allPinned = (entries: readonly ThreadListEntry[]) =>
  entries.length > 0 && entries.every((entry) => entry.pinned === true);

/** The picked-thread actions, in the order every surface lists them. */
function bulkActions(
  entries: readonly ThreadListEntry[],
  selection: HomeSelection,
  actions: ReturnType<typeof useThreadActions>,
) {
  const unpin = allPinned(entries);
  return [
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
      id: "archive",
      label: `Archive ${count(entries.length)}…`,
      icon: ArchiveIcon,
      danger: false,
      run: () => selection.ask("archive"),
    },
    {
      id: "delete",
      label: `Delete ${count(entries.length)}…`,
      icon: TrashIcon,
      danger: true,
      run: () => selection.ask("delete"),
    },
  ];
}

/** Under the list while threads are picked: how many, what to do with them, and Clear. */
export function BulkBar() {
  const selection = useHomeSelection();
  const actions = useThreadActions();
  const entries = usePicked();
  if (!entries.length) return null;
  return (
    <>
      <div
        role="toolbar"
        aria-label="Selected threads"
        className="glass mx-2 mb-2 flex items-center gap-0.5 rounded-lg py-1 pr-1 pl-3 text-ui"
      >
        <span className="mr-auto font-medium whitespace-nowrap tabular-nums" aria-live="polite">
          {entries.length} selected
        </span>
        {bulkActions(entries, selection, actions).map((action) => (
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
  const actions = useThreadActions();
  const entries = usePicked();
  const list = bulkActions(entries, selection, actions);
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

const copy: Record<BulkConfirm, { title: string; body: string; verb: string }> = {
  archive: {
    title: "Archive",
    body: "They leave the list on every device. Undo brings them back for a few seconds after.",
    verb: "Archive",
  },
  delete: {
    title: "Delete",
    body: "They are hidden on every device at once and deleted for good when the Undo toast closes.",
    verb: "Delete",
  },
};

/** The question before archiving or deleting the picked threads; Cancel has focus. */
function BulkConfirmDialog(props: { entries: readonly ThreadListEntry[] }) {
  const selection = useHomeSelection();
  const { confirm } = useHomeSelectionState();
  const actions = useThreadActions();
  const cancel = useRef<HTMLButtonElement>(null);
  const words = copy[confirm ?? "archive"];
  const n = props.entries.length;
  const shown = props.entries.slice(0, 5);
  const go = () => {
    if (confirm === "delete") actions.removeMany(props.entries);
    else actions.archiveMany(props.entries);
    selection.clear();
  };
  return (
    <Dialog open={confirm !== undefined} onOpenChange={(open) => !open && selection.ask(undefined)}>
      <DialogContent initialFocus={cancel} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {words.title} {count(n)}?
          </DialogTitle>
          <DialogDescription>{words.body}</DialogDescription>
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
          <Button variant={confirm === "delete" ? "danger" : "primary"} onClick={go}>
            {words.verb} {count(n)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
