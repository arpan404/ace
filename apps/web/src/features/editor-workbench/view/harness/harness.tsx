import { defaultExplorer, type EditorLayout } from "@ace/ui-core/editor-workbench";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { themeStylesheet } from "@/theme/css.ts";
import "@/styles/index.css";
import { Deck } from "../deck.tsx";
import type { DeckEditorProps } from "../deck-host.ts";
import { memoryBuffers } from "../memory-buffers.ts";
import { OpenEditors } from "../open-editors.tsx";
import { sampleCode } from "./sample-code.ts";

/*
 * Dev-only: the Deck with fake buffers, for screenshots against the mockup. `?scheme=light`,
 * `?state=empty|loading|binary` pick what it shows. Not part of the app's build.
 */

const query = new URLSearchParams(location.search);
const scheme = query.get("scheme") === "light" ? "light" : "dark";
document.documentElement.dataset.scheme = scheme;
const sheet = document.createElement("style");
sheet.textContent = themeStylesheet("ace");
document.head.append(sheet);

const tabs = "packages/ui-core/src/workspace-tabs.ts";
const groups = "apps/web/src/features/editor/editor-groups.ts";

const buffers = memoryBuffers({
  [tabs]: {
    unsaved: true,
    baseVersion: "1",
    diskVersion: "2",
    changedBy: { name: "Claude Code", provider: "claude" },
  },
  "apps/web/src/lib/workspace/store.ts": {
    unseenAgentChange: true,
    changedBy: { name: "Claude Code", provider: "claude" },
  },
  "apps/web/src/features/shell/workspace/tab-strip.tsx": {},
  "store.db": { load: { state: "binary" } },
  "dist/bundle.js": { load: { state: "too-large", bytes: 48_000_000 } },
  "src/a.ts": { load: { state: "loading" } },
});

function initialLayout(): EditorLayout {
  const base = { explorer: defaultExplorer, closed: [] };
  const state = query.get("state");
  if (state === "empty")
    return { ...base, root: { kind: "group", id: "g1", tabs: [], mru: [] }, focused: "g1" };
  if (state === "binary" || state === "loading") {
    const path = state === "binary" ? "store.db" : "src/a.ts";
    const one = { path, preview: false, pinned: false };
    return {
      ...base,
      root: { kind: "group", id: "g1", tabs: [one], active: path, mru: [path] },
      focused: "g1",
    };
  }
  return {
    ...base,
    focused: "g1",
    root: {
      kind: "split",
      direction: "row",
      sizes: [0.56, 0.44],
      children: [
        {
          kind: "group",
          id: "g1",
          tabs: [
            {
              path: "apps/web/src/features/shell/workspace/tab-strip.tsx",
              preview: false,
              pinned: true,
            },
            { path: tabs, preview: false, pinned: false },
            { path: "apps/web/src/lib/workspace/store.ts", preview: false, pinned: false },
            { path: "apps/web/src/lib/workspace/places.ts", preview: true, pinned: false },
          ],
          active: tabs,
          mru: [tabs],
        },
        {
          kind: "group",
          id: "g2",
          tabs: [
            { path: groups, preview: false, pinned: false },
            { path: "docs/editor/workbench.md", preview: false, pinned: false },
          ],
          active: groups,
          mru: [groups],
        },
      ],
    },
  };
}

function FakeEditor(props: DeckEditorProps) {
  const { onStatus, path } = props;
  const lines = (sampleCode[path] ?? `// ${path}`)
    .split("\n")
    .map((text, index) => ({ text, number: index + 1 }));
  useEffect(() => {
    onStatus({
      items: [
        { id: "pos", label: "Ln 25, Col 35", run: () => {} },
        { id: "indent", label: "Spaces: 2", run: () => {} },
        { id: "encoding", label: "UTF-8", run: () => {} },
        { id: "eol", label: "LF", run: () => {} },
        { id: "language", label: "TypeScript", run: () => {} },
      ],
    });
    return () => onStatus(undefined);
  }, [onStatus]);
  return (
    <div className="min-h-0 flex-1 overflow-auto pt-1 font-mono text-[12.5px] leading-5">
      {lines.map((line) => (
        <div key={line.number} className="flex whitespace-pre">
          <span className="w-11 shrink-0 pr-2.5 text-right text-faint-foreground tabular-nums">
            {line.number}
          </span>
          <span className="pl-3 text-foreground/85">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function Harness() {
  const [layout, setLayout] = useState(initialLayout);
  const [listOpen, setListOpen] = useState(true);
  const [ids] = useState(() => {
    let next = 2;
    return () => `g${++next}`;
  });
  const shared = { layout, onLayoutChange: setLayout, newGroupId: ids, buffers };
  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside className="hidden w-[236px] shrink-0 border-r border-border bg-sidebar pt-1.5 min-[760px]:block">
        <OpenEditors {...shared} onSaveAll={() => {}} open={listOpen} onOpenChange={setListOpen} />
      </aside>
      <div className="min-w-0 flex-1">
        <Deck
          {...shared}
          renderEditor={(props) => <FakeEditor {...props} />}
          onMerge={() => {}}
          onCompare={() => {}}
          onQuickOpen={() => {}}
          onNextChange={() => {}}
        />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
