import type { ProviderKind } from "@ace/protocol";
import {
  defaultExplorer,
  groupsOf,
  type EditorLayout,
  type EditorTab,
  type GroupNode,
} from "@ace/ui-core/editor-workbench";
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { createBufferRegistry, type Author, type FilePort } from "../buffers/index.ts";
import {
  fakeDisk,
  inlineMerge,
  manualTime,
  memoryDrafts,
  ready,
  settle,
} from "../buffers/test-support.ts";
import { useEditorBuffers } from "./editor-buffers.ts";
import { Editor, type EditorProps } from "./editor.tsx";
import { OpenEditors } from "./open-editors.tsx";

/*
 * The editor on a real buffer registry (W2) over a fake checkout: files on a fake disk an agent
 * can write behind the editor's back, drafts in memory, the real merge, a clock that moves when
 * told. Only what ace can't control is fake.
 */

export const root = "m1/t1";

export function tab(path: string, extra: Partial<EditorTab> = {}): EditorTab {
  return { path, preview: false, pinned: false, ...extra };
}

export function group(id: string, tabs: EditorTab[], active = tabs[0]?.path): GroupNode {
  return { kind: "group", id, tabs, active, mru: active ? [active] : [] };
}

export type Start = Pick<EditorLayout, "root" | "focused">;

const providerOf = (agent: string): ProviderKind | undefined =>
  agent === "Claude Code" ? "claude" : undefined;

/** Paths that read as something other than text ("binary", "large"), or never finish reading. */
export interface Odd {
  unreadable?: Record<string, string>;
  pending?: readonly string[];
}

export interface MountOptions {
  overrides?: Partial<EditorProps>;
  /** Who the registry credits for a disk change. */
  author?: Author;
  odd?: Odd;
  onSaveAll?: (paths: readonly string[]) => void;
}

/** Renders an editor and its Open editors over a fresh checkout holding every path in `start`. */
export async function mountEditor(start: Start, options: MountOptions = {}) {
  const layout: EditorLayout = { explorer: defaultExplorer, closed: [], ...start };
  const paths = groupsOf(layout).flatMap((each) => each.tabs.map((one) => one.path));
  const disk = fakeDisk(Object.fromEntries(paths.map((path) => [path, `// ${path}\nline two\n`])));
  const time = manualTime();
  const registry = createBufferRegistry({
    files: oddFiles(disk.port, options.odd ?? {}),
    drafts: memoryDrafts().store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
    attribute: () => options.author ?? { kind: "unknown" },
  });
  const seen: EditorLayout[] = [];
  const view = render(
    <StatefulEditor
      initial={layout}
      registry={registry}
      onLayout={(next) => seen.push(next)}
      options={options}
    />,
  );
  await act(settle);
  const buffer = (path: string) => {
    const found = registry.get({ root, path });
    if (!found) throw new Error(`${path} is not open`);
    return found;
  };
  return {
    ...view,
    disk,
    registry,
    seen,
    time,
    /** Types at the end of a file, as a view's edit would. */
    edit(path: string, text: string) {
      const target = buffer(path);
      const doc = target.document();
      if (!doc) throw new Error(`${path} has no document`);
      const last = doc.lenLines() - 1;
      const end = { line: last, column: doc.line(last).length };
      act(() => {
        doc.apply([{ range: { start: end, end }, text }]);
        target.edited();
      });
    },
    /** Someone else writes the file and the watcher reports it. */
    async changeOnDisk(path: string, text: string) {
      disk.write(path, text);
      registry.diskChanged({ root, path });
      await act(settle);
    },
  };
}

function oddFiles(port: FilePort, odd: Odd): FilePort {
  return {
    read: (key, signal) => {
      if (odd.pending?.includes(key.path)) return new Promise(() => {});
      const reason = odd.unreadable?.[key.path];
      if (reason) return Promise.resolve({ kind: "unreadable", reason });
      return port.read(key, signal);
    },
    write: port.write,
  };
}

function StatefulEditor(props: {
  initial: EditorLayout;
  registry: ReturnType<typeof createBufferRegistry>;
  onLayout(layout: EditorLayout): void;
  options: MountOptions;
}) {
  const [layout, setLayout] = useState(props.initial);
  const [newGroupId] = useState(() => {
    let next = 0;
    return () => `g${++next}`;
  });
  const buffers = useEditorBuffers(props.registry, root, layout, providerOf);
  const change = (next: EditorLayout) => {
    setLayout(next);
    props.onLayout(next);
  };
  const shared = { layout, onLayoutChange: change, newGroupId, buffers };
  return (
    <div>
      <OpenEditors
        {...shared}
        onSaveAll={props.options.onSaveAll ?? (() => {})}
        open
        onOpenChange={() => {}}
      />
      <Editor {...shared} {...props.options.overrides} />
    </div>
  );
}
