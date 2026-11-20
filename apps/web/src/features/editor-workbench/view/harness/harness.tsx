import { defaultExplorer, type EditorLayout } from "@ace/ui-core/editor-workbench";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ensureEditorReady } from "@/features/editor";
import { themeStylesheet } from "@/theme/css.ts";
import "@/styles/index.css";
import {
  createBufferRegistry,
  workerMerge,
  type BufferKey,
  type Draft,
  type FilePort,
} from "../../buffers/index.ts";
import { useDeckBuffers } from "../deck-buffers.ts";
import { Deck } from "../deck.tsx";
import { OpenEditors } from "../open-editors.tsx";
import { sampleCode } from "./sample-code.ts";

/*
 * Dev-only: the Deck on the real buffer registry and editor over an in-memory checkout, for
 * screenshots against the mockup. `?scheme=light`, `?state=empty|loading|binary` pick what it
 * shows. Not part of the app's build.
 */

const query = new URLSearchParams(location.search);
const scheme = query.get("scheme") === "light" ? "light" : "dark";
document.documentElement.dataset.scheme = scheme;
const sheet = document.createElement("style");
sheet.textContent = themeStylesheet("ace");
document.head.append(sheet);

const root = "harness/t1";
const tabs = "packages/ui-core/src/workspace-tabs.ts";
const groups = "apps/web/src/features/editor/editor-groups.ts";

/** The checkout: sample files, a binary, and one file whose read never finishes. */
const files = new Map<string, { text: string; version: number }>();
const textOf = (path: string) => sampleCode[path] ?? `// ${path}\n`;
const port: FilePort = {
  read: async (key) => {
    if (key.path === "src/a.ts") return new Promise(() => {});
    if (key.path === "store.db") return { kind: "unreadable", reason: "binary" };
    const file = files.get(key.path) ?? { text: textOf(key.path), version: 1 };
    files.set(key.path, file);
    return { kind: "text", text: file.text, version: `v${file.version}` };
  },
  write: async (key, text) => {
    const version = (files.get(key.path)?.version ?? 0) + 1;
    files.set(key.path, { text, version });
    return { kind: "saved", version: `v${version}` };
  },
};
const drafts = new Map<string, Draft>();
const id = (key: BufferKey) => `${key.root}:${key.path}`;
const registry = createBufferRegistry({
  files: port,
  drafts: {
    get: async (key) => drafts.get(id(key)),
    put: async (key, draft) => void drafts.set(id(key), draft),
    delete: async (key) => void drafts.delete(id(key)),
    list: async () => [],
  },
  merge: workerMerge(ensureEditorReady),
  now: () => performance.now(),
  schedule: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  ready: ensureEditorReady,
  attribute: () => ({ kind: "agent", agent: "Claude Code", threadId: "t1" }),
});
const providerOf = (agent: string) => (agent === "Claude Code" ? ("claude" as const) : undefined);

/** Once loaded: the person types in workspace-tabs.ts, then Claude Code writes its top. */
let staged = false;
async function stage(): Promise<void> {
  // Once per page, though StrictMode runs the effect that calls it twice.
  if (staged) return;
  staged = true;
  for (let tries = 0; tries < 100; tries++) {
    const doc = registry.get({ root, path: tabs })?.document();
    if (doc) {
      const buffer = registry.get({ root, path: tabs });
      const end = { line: Math.max(0, doc.lenLines() - 2), column: 0 };
      doc.apply([{ range: { start: end, end }, text: "  // kept\n" }]);
      buffer?.edited();
      const file = files.get(tabs);
      if (file) files.set(tabs, { text: `// agent\n${file.text}`, version: file.version + 1 });
      registry.diskChanged({ root, path: tabs });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

function Harness() {
  const [layout, setLayout] = useState(initialLayout);
  const [listOpen, setListOpen] = useState(true);
  const [ids] = useState(() => {
    let next = 2;
    return () => `g${++next}`;
  });
  const buffers = useDeckBuffers(registry, root, layout, providerOf);
  useEffect(() => void stage(), []);
  const shared = { layout, onLayoutChange: setLayout, newGroupId: ids, buffers };
  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside className="hidden w-[236px] shrink-0 border-r border-border bg-sidebar pt-1.5 min-[760px]:block">
        <OpenEditors {...shared} onSaveAll={() => {}} open={listOpen} onOpenChange={setListOpen} />
      </aside>
      <div className="min-w-0 flex-1">
        <Deck {...shared} onQuickOpen={() => {}} />
      </div>
    </div>
  );
}

const mount = document.getElementById("root");
if (mount)
  createRoot(mount).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
