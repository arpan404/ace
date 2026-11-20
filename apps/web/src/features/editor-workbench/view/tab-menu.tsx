import type { EditorTab, GroupNode } from "@ace/ui-core/editor-workbench";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import type { GroupActions } from "./group-actions.ts";

const unpinned = (tabs: readonly EditorTab[]) => tabs.some((each) => !each.pinned);

/**
 * A tab's context menu (spec 24): the close variants (pinned tabs stay for all but Close all),
 * pin, keep, splits and the path. Open in and Reveal in Files join with W4 and W5.
 */
export function TabMenu(props: {
  group: GroupNode;
  tab: EditorTab;
  actions: GroupActions;
  children: ReactNode;
}) {
  const { group, tab, actions } = props;
  const index = group.tabs.indexOf(tab);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex" />}>{props.children}</ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItem onClick={() => actions.close([tab.path])}>Close</MenuItem>
        <MenuItem
          disabled={!unpinned(group.tabs.filter((each) => each !== tab))}
          onClick={() => actions.closeVariant(tab.path, "others")}
        >
          Close others
        </MenuItem>
        <MenuItem
          disabled={!unpinned(group.tabs.slice(index + 1))}
          onClick={() => actions.closeVariant(tab.path, "right")}
        >
          Close to the right
        </MenuItem>
        <MenuItem onClick={() => actions.closeVariant(tab.path, "saved")}>Close saved</MenuItem>
        <MenuItem onClick={() => actions.closeVariant(tab.path, "all")}>Close all</MenuItem>
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
