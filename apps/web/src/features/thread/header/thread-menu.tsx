import { useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { threadRowFlags } from "@ace/ui-core";
import { MenuItem, MenuSub, MenuSubTrigger, MenuContent } from "@/components/ui/menu.tsx";
import {
  ThreadActionItems,
  useOrganizerState,
  useThreadActions,
} from "@/features/organize/index.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useNow } from "@/lib/time.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useLatestForkPoint } from "../transitions/use-fork-point.ts";
import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

const DeferredOpenIn = deferredComponent(() =>
  import("./thread-open-in.tsx").then((module) => module.ThreadOpenIn),
);

/**
 * The header's ⋯ menu: the same thread actions as the Home row's context menu, with the open
 * thread's shortcuts, plus the agent tree, then the long-thread tools (search
 * and turns). Archiving or deleting steps back to Home. Dialogs belong to the caller, since the
 * menu closes on choosing.
 */
export function ThreadMenuItems(props: {
  thread: ThreadRef;
  onRename(): void;
  onFork(point: ForkPoint): void;
  onAttachments(): void;
}) {
  const meta = useThreadMeta(props.thread.id);
  const point = useLatestForkPoint(props.thread.id);
  const { baseline } = useOrganizerState();
  const now = useNow();
  const navigate = useNavigate();
  if (!meta) return null;
  const flags = threadRowFlags(meta, { baseline, now, settled: meta.settledAt !== undefined });
  return (
    <ThreadActionItems
      entry={meta}
      flags={flags}
      onRename={props.onRename}
      fork={{ point, onFork: props.onFork }}
      compact
      shortcuts
      onLeave={() => void navigate({ to: "/" })}
      extra={
        <>
          <MenuSub>
            <MenuSubTrigger icon={<ArrowSquareOutIcon aria-hidden size={16} />}>
              Open in…
            </MenuSubTrigger>
            <MenuContent>
              <Suspense fallback={<MenuItem disabled>Looking for editors…</MenuItem>}>
                <DeferredOpenIn.Component thread={props.thread} />
              </Suspense>
            </MenuContent>
          </MenuSub>
        </>
      }
    />
  );
}

/**
 * The open thread's own shortcuts, the ones its ⋯ menu shows: ⌥⌘R rename, ⌥⌘P pin or unpin,
 * ⇧⌘A archive (which steps back to Home, with Undo). Loaded with the menu's code, after the
 * transcript has painted.
 */
export function ThreadHotkeys(props: { thread: ThreadRef; onRename(): void }) {
  const meta = useThreadMeta(props.thread.id);
  const actions = useThreadActions();
  const navigate = useNavigate();
  const ready = meta !== undefined;
  useHotkey(keymap.renameThread.keys, props.onRename, { enabled: ready });
  useHotkey(keymap.pinThread.keys, () => meta && actions.setPinned(meta, meta.pinned !== true), {
    enabled: ready,
  });
  useHotkey(
    keymap.archiveThread.keys,
    () => {
      if (!meta) return;
      actions.archive(meta);
      void navigate({ to: "/" });
    },
    // An archived thread is restored from its menu or the archive, never archived again.
    { enabled: ready && meta.archivedAt === undefined },
  );
  return null;
}
