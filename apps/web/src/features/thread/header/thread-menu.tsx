import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import {
  ArchiveIcon,
  CheckIcon,
  GitForkIcon,
  LinkIcon,
  MoonIcon,
  PencilSimpleIcon,
  TrashIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { SnoozeUntil } from "../sources/thread-actions-source.ts";

const snoozes: readonly SnoozeUntil[] = ["1 hour", "Tomorrow 9:00", "Next Monday"];

/** The ⋯ menu beside the thread title. Renaming opens a dialog owned by the caller. */
export function ThreadMenuItems(props: { thread: ThreadRef; onRename(): void }) {
  const { thread } = props;
  const client = useClient();
  const sources = useThreadSources();
  const toast = useToast();
  const navigate = useNavigate();
  const { setTab, setPanelOpen } = useLayout();
  const failed = (what: string) => () => toast.add({ title: `Couldn't ${what}` });
  return (
    <>
      <MenuItem icon={<PencilSimpleIcon aria-hidden size={16} />} onClick={props.onRename}>
        Rename
      </MenuItem>
      <MenuItem
        icon={<GitForkIcon aria-hidden size={16} />}
        onClick={() =>
          sources.actions
            .fork(thread)
            .then(
              () => toast.add({ title: "Forked · a new thread continues from here" }),
              failed("fork the thread"),
            )
        }
      >
        Fork thread
      </MenuItem>
      <MenuItem
        icon={<TreeStructureIcon aria-hidden size={16} />}
        keys={keymap.agents.keys}
        onClick={() => {
          setTab("right", "agents");
          setPanelOpen("right", true);
        }}
      >
        Open agent tree
      </MenuItem>
      <MenuItem
        icon={<LinkIcon aria-hidden size={16} />}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(new URL(`/t/${thread.id}`, location.href).href)
            .then(() => toast.add({ title: "Link copied" }), failed("copy the link"))
        }
      >
        Copy link
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<CheckIcon aria-hidden size={16} />}
        onClick={() =>
          sources.actions
            .settle(thread)
            .then(
              () => toast.add({ title: `Settled · ${thread.title}` }),
              failed("settle the thread"),
            )
        }
      >
        Settle
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger icon={<MoonIcon aria-hidden size={16} />}>Snooze</MenuSubTrigger>
        <MenuContent side="right" align="start" sideOffset={4}>
          {snoozes.map((until) => (
            <MenuItem
              key={until}
              onClick={() =>
                sources.actions
                  .snooze(thread, until)
                  .then(
                    () => toast.add({ title: `Snoozed until ${until.toLowerCase()}` }),
                    failed("snooze the thread"),
                  )
              }
            >
              {until}
            </MenuItem>
          ))}
        </MenuContent>
      </MenuSub>
      <MenuItem
        icon={<ArchiveIcon aria-hidden size={16} />}
        onClick={() =>
          client
            .enqueue({ type: "thread.archive", threadId: ThreadId.parse(thread.id) })
            .then(() => {
              toast.add({ title: `Archived · ${thread.title}` });
              void navigate({ to: "/" });
            }, failed("archive the thread"))
        }
      >
        Archive
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        danger
        icon={<TrashIcon aria-hidden size={16} />}
        onClick={() =>
          sources.actions.remove(thread).then(() => {
            toast.add({
              title: `Deleted · ${thread.title}`,
              actionProps: {
                children: "Undo",
                onClick: () => void sources.actions.restore(thread),
              },
            });
            void navigate({ to: "/" });
          }, failed("delete the thread"))
        }
      >
        Delete thread
      </MenuItem>
    </>
  );
}

/** Rename the thread. Mounted while open, so it starts from the current title. */
export function RenameDialog(props: { thread: ThreadRef; onClose(): void }) {
  const sources = useThreadSources();
  const toast = useToast();
  const [title, setTitle] = useState(props.thread.title);
  const save = () => {
    const next = title.trim();
    if (!next || next === props.thread.title) return props.onClose();
    sources.actions.rename(props.thread, next).then(
      () => props.onClose(),
      () => toast.add({ title: "Couldn't rename the thread" }),
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
            <DialogDescription>The title shows in the Home list and the header.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Thread title"
            value={title}
            maxLength={200}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
