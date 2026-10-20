import type { ForkPoint, ThreadListEntry } from "@ace/protocol";
import type { ThreadRowFlags } from "@ace/ui-core";
import { GitPullRequestIcon, LinkBreakIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { MenuItem } from "@/components/ui/menu.tsx";
import { ThreadActionItems } from "@/features/organize/index.ts";
import { PrLinksDialog, useLatestForkPoint, useOpenFork } from "@/features/thread/index.ts";

/** What the row menus open beyond themselves: the pull request links, and a fork's own thread. */
export function useRowDialogs(entry: ThreadListEntry) {
  const [prDialog, setPrDialog] = useState<"link" | "unlink">();
  const openFork = useOpenFork();
  const dialogs = prDialog && (
    <PrLinksDialog thread={entry} kind={prDialog} onClose={() => setPrDialog(undefined)} />
  );
  return { onPr: setPrDialog, onFork: (point: ForkPoint) => openFork(entry.id, point), dialogs };
}

/**
 * A row's menu items, the same in its right-click menu and its ⋯ menu. Mounted only while the
 * menu is open: that is when the fork point is read.
 */
export function RowItems(props: {
  entry: ThreadListEntry;
  state: ThreadRowFlags;
  onRename(): void;
  onPr(kind: "link" | "unlink"): void;
  onFork(point: ForkPoint): void;
}) {
  const point = useLatestForkPoint(props.entry.id);
  return (
    <ThreadActionItems
      entry={props.entry}
      flags={props.state}
      onRename={props.onRename}
      fork={{ point, onFork: props.onFork }}
      extra={
        <>
          <MenuItem
            icon={<GitPullRequestIcon aria-hidden size={16} />}
            onClick={() => props.onPr("link")}
          >
            Link pull request…
          </MenuItem>
          {(props.entry.details?.linkedPrs?.length || props.entry.details?.linkedPr) && (
            <MenuItem
              icon={<LinkBreakIcon aria-hidden size={16} />}
              onClick={() => props.onPr("unlink")}
            >
              Unlink all pull requests
            </MenuItem>
          )}
        </>
      }
    />
  );
}
