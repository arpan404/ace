import { useState } from "react";
import { Deck, type DeckProps } from "./deck.tsx";
import {
  defaultExplorer,
  type EditorLayout,
  type EditorTab,
  type GroupNode,
} from "@ace/ui-core/editor-workbench";
import type { MemoryBuffers } from "./memory-buffers.ts";
import { OpenEditors } from "./open-editors.tsx";

export function tab(path: string, extra: Partial<EditorTab> = {}): EditorTab {
  return { path, preview: false, pinned: false, ...extra };
}

export function group(id: string, tabs: EditorTab[], active = tabs[0]?.path): GroupNode {
  return { kind: "group", id, tabs, active, mru: active ? [active] : [] };
}

/** A Deck (and its Open editors list) holding its own layout, as the editor panel will. */
export function StatefulDeck(props: {
  initial: Pick<EditorLayout, "root" | "focused">;
  buffers: MemoryBuffers;
  overrides?: Partial<DeckProps>;
  onLayout?: (layout: EditorLayout) => void;
  onSaveAll?: (paths: readonly string[]) => void;
}) {
  const [layout, setLayout] = useState<EditorLayout>(() => ({
    explorer: defaultExplorer,
    closed: [],
    ...props.initial,
  }));
  const [newGroupId] = useState(() => {
    let next = 0;
    return () => `g${++next}`;
  });
  const change = (next: EditorLayout) => {
    setLayout(next);
    props.onLayout?.(next);
  };
  return (
    <div>
      <OpenEditors
        layout={layout}
        newGroupId={newGroupId}
        onLayoutChange={change}
        buffers={props.buffers}
        onSaveAll={props.onSaveAll ?? (() => {})}
        open
        onOpenChange={() => {}}
      />
      <Deck
        layout={layout}
        newGroupId={newGroupId}
        onLayoutChange={change}
        buffers={props.buffers}
        renderEditor={(editor) => (
          <textarea aria-label={`Editor ${editor.path}`} data-group={editor.group} readOnly />
        )}
        onMerge={() => {}}
        onCompare={() => {}}
        {...props.overrides}
      />
    </div>
  );
}
