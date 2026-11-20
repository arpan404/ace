import { useState } from "react";
import { Deck, type DeckProps } from "./deck.tsx";
import { createInterimOps } from "./interim-ops.ts";
import type { DeckGroup, DeckLayout, DeckTab } from "./layout.ts";
import type { MemoryBuffers } from "./memory-buffers.ts";
import { OpenEditors } from "./open-editors.tsx";

export function tab(path: string, extra: Partial<DeckTab> = {}): DeckTab {
  return { path, preview: false, pinned: false, ...extra };
}

export function group(id: string, tabs: DeckTab[], active = tabs[0]?.path): DeckGroup {
  return { kind: "group", id, tabs, active, mru: active ? [active] : [] };
}

/** A Deck (and its Open editors list) holding its own layout, as the editor panel will. */
export function StatefulDeck(props: {
  initial: DeckLayout;
  buffers: MemoryBuffers;
  overrides?: Partial<DeckProps>;
  onLayout?: (layout: DeckLayout) => void;
  onSaveAll?: (paths: readonly string[]) => void;
}) {
  const [layout, setLayout] = useState(props.initial);
  const [ops] = useState(() => {
    let next = 0;
    return createInterimOps(() => `g${++next}`);
  });
  const change = (next: DeckLayout) => {
    setLayout(next);
    props.onLayout?.(next);
  };
  return (
    <div>
      <OpenEditors
        layout={layout}
        ops={ops}
        onLayoutChange={change}
        buffers={props.buffers}
        onSaveAll={props.onSaveAll ?? (() => {})}
        open
        onOpenChange={() => {}}
      />
      <Deck
        layout={layout}
        ops={ops}
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
