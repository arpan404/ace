import { CaretDownIcon, CaretRightIcon } from "@ace/icons";
import { useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn.ts";
import { useAgentMark, useSnapshot, type DeckBuffers } from "./deck-buffers.ts";
import {
  bindGroupActions,
  groupContext,
  type DeckLayoutProps,
  type GroupActions,
} from "./group-actions.ts";
import { groupsOf, type EditorTab, type GroupNode } from "@ace/ui-core/editor-workbench";
import { fileName, folderOf } from "./paths.ts";
import { slotShows, TabSlot } from "./tab-slot.tsx";

/**
 * The explorer's first section (spec 29): one row per open editor, under "Group 1", "Group 2"
 * when there is more than one group, each with its folder and the same slot as its tab. Save all
 * shows only while something is unsaved. Folding is the caller's to remember per device.
 */
export function OpenEditors(
  props: DeckLayoutProps & {
    onSaveAll(paths: readonly string[]): void;
    open: boolean;
    onOpenChange(open: boolean): void;
  },
) {
  const { layout, buffers } = props;
  const groups = groupsOf(layout);
  const context = groupContext(props);
  const paths = [...new Set(groups.flatMap((group) => group.tabs.map((tab) => tab.path)))];
  const unsaved = useUnsaved(buffers, paths);
  const Caret = props.open ? CaretDownIcon : CaretRightIcon;
  return (
    <section aria-label="Open editors" className="flex flex-col pb-1.5">
      <div className="flex h-7 items-center pr-2.5 pl-2">
        <button
          type="button"
          aria-expanded={props.open}
          onClick={() => props.onOpenChange(!props.open)}
          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground focus-ring-inset"
        >
          <Caret aria-hidden size={12} className="text-faint-foreground" />
          Open editors
        </button>
        {unsaved.length > 0 && (
          <button
            type="button"
            onClick={() => props.onSaveAll(unsaved)}
            className="h-5 rounded-sm px-1.5 text-xs font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:text-foreground"
          >
            Save all
          </button>
        )}
      </div>
      {props.open && (
        <ul className="flex flex-col">
          {groups.map((group, index) => (
            <li key={group.id}>
              {groups.length > 1 && (
                <div className="pt-1.5 pr-3 pb-0.5 pl-6 text-xs text-subtle-foreground">
                  Group {index + 1}
                </div>
              )}
              <ul>
                {group.tabs.map((tab) => (
                  <OpenEditorRow
                    key={tab.path}
                    group={group}
                    tab={tab}
                    current={group.id === layout.focused && group.active === tab.path}
                    buffers={buffers}
                    actions={bindGroupActions(group.id, context)}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OpenEditorRow(props: {
  group: GroupNode;
  tab: EditorTab;
  current: boolean;
  buffers: DeckBuffers;
  actions: GroupActions;
}) {
  const { tab, actions } = props;
  const unsaved = useSnapshot(props.buffers, tab.path)?.dirty ?? false;
  const mark = useAgentMark(props.buffers, tab.path);
  const [hovered, setHovered] = useState(false);
  const name = fileName(tab.path);
  return (
    <li
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "mx-1.5 flex h-6 items-center gap-1.5 rounded-sm pr-1 pl-6 text-ui",
        props.current ? "bg-active text-foreground" : "text-muted-foreground hover:bg-hover",
      )}
    >
      <button
        type="button"
        aria-current={props.current ? "true" : undefined}
        title={tab.path}
        onClick={() => actions.activate(tab.path)}
        onDoubleClick={() => actions.keep(tab.path)}
        onAuxClick={(event) => {
          if (event.button === 1) actions.close([tab.path]);
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left focus-ring-inset"
      >
        <span className={cn("shrink-0", tab.preview && "italic")}>{name}</span>
        <span className="min-w-0 truncate text-xs text-subtle-foreground">
          {folderOf(tab.path)}
        </span>
      </button>
      <TabSlot
        shows={slotShows(unsaved, tab.pinned, hovered, hovered, mark !== undefined)}
        unsaved={unsaved}
        name={name}
        provider={mark?.provider}
        onClose={() => actions.close([tab.path])}
      />
    </li>
  );
}

/** The unsaved open paths, as a stable string so the list re-renders only when it changes. */
function useUnsaved(buffers: DeckBuffers, paths: readonly string[]): string[] {
  const key = useSyncExternalStore(buffers.subscribe, () =>
    paths.filter((path) => buffers.snapshot(path)?.dirty).join("\n"),
  );
  return key ? key.split("\n") : [];
}
