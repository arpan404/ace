import { useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { TreeStructureIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { threadRowFlags } from "@ace/ui-core";
import { MenuItem } from "@/components/ui/menu.tsx";
import { ThreadActionItems, useOrganizerState } from "@/features/organize/index.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useNow } from "@/lib/time.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useLatestForkPoint } from "../transitions/use-fork-point.ts";

/**
 * The ⋯ menu beside the thread title: the same thread actions as the Home row's context menu,
 * plus the agent tree. Archiving or deleting steps back to Home. Dialogs belong to the caller,
 * since the menu closes on choosing.
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
  const { setTab, setPanelOpen } = useLayout();
  if (!meta) return null;
  const flags = threadRowFlags(meta, { baseline, now, settled: meta.settledAt !== undefined });
  return (
    <ThreadActionItems
      entry={meta}
      flags={flags}
      onRename={props.onRename}
      fork={{ point, onFork: props.onFork }}
      onLeave={() => void navigate({ to: "/" })}
      extra={
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
      }
    />
  );
}
