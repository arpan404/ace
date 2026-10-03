import { useThreadMeta, useThreadStore } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CheckIcon,
  GitForkIcon,
  LinkIcon,
  MoonIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TrashIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { describeWake, snoozePresets } from "@ace/ui-core";
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
import { failureMessage } from "@/lib/daemon-command.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useNow } from "@/lib/time.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { latestForkPoint } from "../transitions/fork-point.ts";

/**
 * The ⋯ menu beside the thread title: rename, fork, the agent tree, the link, and the thread's
 * organization on the daemon (pin, settle, snooze, archive, delete). Dialogs belong to the
 * caller, since the menu closes on choosing.
 */
export function ThreadMenuItems(props: {
  thread: ThreadRef;
  onRename(): void;
  onFork(point: ForkPoint): void;
  onDelete(): void;
}) {
  const { thread } = props;
  const meta = useThreadMeta(thread.id);
  const store = useThreadStore(thread.id);
  const sources = useThreadSources();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow();
  const { setTab, setPanelOpen } = useLayout();
  const act = (what: string, action: Promise<void>, done?: string) =>
    action.then(
      () => done && toast.add({ title: done }),
      (error: unknown) =>
        toast.add({ title: `Couldn't ${what}`, description: failureMessage(error) }),
    );
  const forkPoint = store && latestForkPoint(store, meta?.rootAgentId);
  const settled = meta?.settledAt !== undefined;
  const snoozed = meta?.snoozedUntil !== undefined && meta.snoozedUntil > now;
  return (
    <>
      <MenuItem icon={<PencilSimpleIcon aria-hidden size={16} />} onClick={props.onRename}>
        Rename
      </MenuItem>
      <MenuItem
        icon={<GitForkIcon aria-hidden size={16} />}
        disabled={!forkPoint}
        onClick={() => forkPoint && props.onFork(forkPoint)}
      >
        Fork from the last turn…
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
          void navigator.clipboard?.writeText(new URL(`/t/${thread.id}`, location.href).href).then(
            () => toast.add({ title: "Link copied" }),
            () => toast.add({ title: "Couldn't copy the link" }),
          )
        }
      >
        Copy link
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={
          meta?.pinned ? (
            <PushPinSlashIcon aria-hidden size={16} />
          ) : (
            <PushPinIcon aria-hidden size={16} />
          )
        }
        onClick={() =>
          void act(
            meta?.pinned ? "unpin the thread" : "pin the thread",
            sources.actions.pin(thread, !meta?.pinned),
          )
        }
      >
        {meta?.pinned ? "Unpin" : "Pin"}
      </MenuItem>
      {settled ? (
        <MenuItem
          icon={<ArrowCounterClockwiseIcon aria-hidden size={16} />}
          onClick={() =>
            void act(
              "unsettle the thread",
              sources.actions.unsettle(thread),
              `Back in the list · ${thread.title}`,
            )
          }
        >
          Unsettle
        </MenuItem>
      ) : (
        meta?.status.state === "done" && (
          <MenuItem
            icon={<CheckIcon aria-hidden size={16} />}
            onClick={() =>
              void act(
                "settle the thread",
                sources.actions.settle(thread),
                `Settled · ${thread.title}`,
              )
            }
          >
            Settle
          </MenuItem>
        )
      )}
      <MenuSub>
        <MenuSubTrigger icon={<MoonIcon aria-hidden size={16} />}>Snooze</MenuSubTrigger>
        <MenuContent side="right" align="start" sideOffset={4}>
          {snoozePresets(now).map((preset) => (
            <MenuItem
              key={preset.id}
              onClick={() =>
                void act(
                  "snooze the thread",
                  sources.actions.snooze(thread, preset.until),
                  `Snoozed until ${describeWake(preset.until, now)}`,
                )
              }
            >
              <span className="flex w-full items-center">
                {preset.label}
                <span className="ml-auto pl-[18px] text-xs text-subtle-foreground">
                  {preset.detail}
                </span>
              </span>
            </MenuItem>
          ))}
          {snoozed && (
            <>
              <MenuSeparator />
              <MenuItem
                onClick={() => void act("wake the thread", sources.actions.snooze(thread, null))}
              >
                Wake now
              </MenuItem>
            </>
          )}
        </MenuContent>
      </MenuSub>
      <MenuItem
        icon={<ArchiveIcon aria-hidden size={16} />}
        onClick={() =>
          sources.actions.archive(thread).then(
            () => {
              const id = toast.add({
                title: `Archived · ${thread.title}`,
                actionProps: {
                  children: "Undo",
                  onClick: () => {
                    toast.close(id);
                    void act("unarchive the thread", sources.actions.unarchive(thread));
                  },
                },
              });
              void navigate({ to: "/" });
            },
            (error: unknown) =>
              toast.add({
                title: "Couldn't archive the thread",
                description: failureMessage(error),
              }),
          )
        }
      >
        Archive
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger icon={<TrashIcon aria-hidden size={16} />} onClick={props.onDelete}>
        Delete thread…
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
      (error: unknown) =>
        toast.add({ title: "Couldn't rename the thread", description: failureMessage(error) }),
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
            maxLength={256}
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

/**
 * Delete for good: the daemon keeps a tombstone and the thread can't run again, so this asks
 * first. It refuses while agents or terminals are still running.
 */
export function DeleteDialog(props: { thread: ThreadRef; onClose(): void }) {
  const sources = useThreadSources();
  const navigate = useNavigate();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const remove = () =>
    sources.actions.remove(props.thread).then(
      () => {
        props.onClose();
        toast.add({ title: `Deleted · ${props.thread.title}` });
        void navigate({ to: "/" });
      },
      (failure: unknown) => setError(failureMessage(failure)),
    );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{props.thread.title}”?</DialogTitle>
          <DialogDescription>
            It leaves every device and can't be opened or continued again. Archive keeps it out of
            the list instead.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-ui text-status-failed">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={() => void remove()}>
            Delete thread
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
