import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import type { DeckBuffers } from "./buffers.ts";
import type { GroupActions } from "./group-actions.ts";
import type { DeckGroup, DeckTab } from "./layout.ts";

/**
 * A tab's context menu (spec 24): the close variants (pinned tabs are skipped by "others" and
 * "to the right"), pin, keep, splits and the path. Open in and Reveal in Files join with W4/W5.
 */
export function TabMenu(props: {
  group: DeckGroup;
  tab: DeckTab;
  buffers: DeckBuffers;
  actions: GroupActions;
  children: ReactNode;
}) {
  const { group, tab, actions } = props;
  const index = group.tabs.indexOf(tab);
  const others = group.tabs.filter((each) => each !== tab && !each.pinned).map((each) => each.path);
  const right = group.tabs
    .slice(index + 1)
    .filter((each) => !each.pinned)
    .map((each) => each.path);
  const saved = () =>
    group.tabs.filter((each) => !props.buffers.facts(each.path).unsaved).map((each) => each.path);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex" />}>{props.children}</ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItem onClick={() => actions.close([tab.path])}>Close</MenuItem>
        <MenuItem disabled={others.length === 0} onClick={() => actions.close(others)}>
          Close others
        </MenuItem>
        <MenuItem disabled={right.length === 0} onClick={() => actions.close(right)}>
          Close to the right
        </MenuItem>
        <MenuItem onClick={() => actions.close(saved())}>Close saved</MenuItem>
        <MenuItem onClick={() => actions.close(group.tabs.map((each) => each.path))}>
          Close all
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => actions.setPinned(tab.path, !tab.pinned)}>
          {tab.pinned ? "Unpin" : "Pin"}
        </MenuItem>
        {tab.preview && <MenuItem onClick={() => actions.keep(tab.path)}>Keep open</MenuItem>}
        <MenuSeparator />
        <MenuItem onClick={() => actions.splitTab(tab.path, "right")}>Split right</MenuItem>
        <MenuItem onClick={() => actions.splitTab(tab.path, "down")}>Split down</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void navigator.clipboard?.writeText(tab.path)}>
          Copy relative path
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
