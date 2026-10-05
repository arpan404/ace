import { useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { ChatsCircleIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { threadRowFlags } from "@ace/ui-core";
import { MenuItem } from "@/components/ui/menu.tsx";
import {
  ThreadActionItems,
  useOrganizerState,
  useThreadActions,
} from "@/features/organize/index.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useNow } from "@/lib/time.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useLatestForkPoint } from "../transitions/use-fork-point.ts";

/**
 * The ⋯ menu beside the thread title: the same thread actions as the Home row's context menu,
 * with the open thread's shortcuts, plus a side chat and the agent tree. Archiving or deleting
 * steps back to Home. Dialogs belong to the caller, since the menu closes on choosing.
 */
export function ThreadMenuItems(props: {
  thread: ThreadRef;
  onRename(): void;
  onFork(point: ForkPoint): void;
}) {
  const meta = useThreadMeta(props.thread.id);
  const point = useLatestForkPoint(props.thread.id);
  const { baseline } = useOrganizerState();
  const now = useNow();
  const navigate = useNavigate();
  const workspace = useWorkspaceActions(props.thread.id);
  if (!meta) return null;
  const flags = threadRowFlags(meta, { baseline, now, settled: meta.settledAt !== undefined });
  return (
    <ThreadActionItems
      entry={meta}
      flags={flags}
      onRename={props.onRename}
      fork={{ point, onFork: props.onFork }}
      shortcuts
      onLeave={() => void navigate({ to: "/" })}
      extra={
        <>
          {/* Side chat has no daemon support yet (PN-07): no shortcut to promise, no tab to open. */}
          <MenuItem
            icon={<ChatsCircleIcon aria-hidden size={16} />}
            disabled
            reason="Not available yet"
          >
            New side chat
          </MenuItem>
          <MenuItem
            icon={<TreeStructureIcon aria-hidden size={16} />}
            keys={keymap.agents.keys}
            onClick={() => workspace.open({ kind: "agents" })}
          >
            Open agent tree
          </MenuItem>
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
    { enabled: ready },
  );
  return null;
}
