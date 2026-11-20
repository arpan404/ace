import { defaultExplorer, type EditorLayout } from "@ace/ui-core/editor-workbench";
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import type { BufferRegistry } from "../buffers/registry.ts";
import type { BufferEvent, BufferKey, BufferSnapshot, TextBuffer } from "../buffers/types.ts";
import { Deck } from "./deck.tsx";
import { group, tab } from "./deck-test-support.tsx";
import { registryBuffers, useRegistryBuffers } from "./registry-buffers.ts";

/*
 * The bridge between the Deck and W2's registry, against a registry fake at the registry's own
 * interface (the real one needs the editor's Wasm): which leases it holds, which are visible,
 * and what the view is told about each buffer.
 */

const clean: BufferSnapshot = {
  status: { kind: "ready" },
  dirty: false,
  clash: undefined,
  draftKept: true,
  saving: false,
  version: "v1",
};

function fakeRegistry() {
  const leases = new Map<string, { visible: boolean; released: boolean }[]>();
  const buffers = new Map<
    string,
    { snapshot: BufferSnapshot; listeners: Set<(event: BufferEvent) => void> }
  >();
  const bufferFor = (key: BufferKey): TextBuffer => {
    let state = buffers.get(key.path);
    if (!state) {
      state = { snapshot: clean, listeners: new Set() };
      buffers.set(key.path, state);
    }
    const own = state;
    return {
      key,
      document: () => undefined,
      snapshot: () => own.snapshot,
      subscribe: (listener) => {
        own.listeners.add(listener);
        return () => own.listeners.delete(listener);
      },
    } as Partial<TextBuffer> as TextBuffer;
  };
  const registry = {
    open: (key: BufferKey) => {
      const hold = { visible: false, released: false };
      leases.set(key.path, [...(leases.get(key.path) ?? []), hold]);
      return {
        buffer: bufferFor(key),
        setVisible: (visible: boolean) => void (hold.visible = visible),
        release: () => void (hold.released = true),
      };
    },
  } as Partial<BufferRegistry> as BufferRegistry;
  return {
    registry,
    /** The live (unreleased) leases of a path. */
    live: (path: string) => (leases.get(path) ?? []).filter((hold) => !hold.released),
    setSnapshot(path: string, change: Partial<BufferSnapshot>) {
      const state = buffers.get(path);
      if (!state) throw new Error(`no buffer for ${path}`);
      state.snapshot = { ...state.snapshot, ...change };
      for (const listener of state.listeners) listener({ type: "state" });
    },
  };
}

const layoutOf = (root: EditorLayout["root"], focused: string): EditorLayout => ({
  root,
  focused,
  explorer: defaultExplorer,
  closed: [],
});

const twoGroups = layoutOf(
  {
    kind: "split",
    direction: "row",
    sizes: [0.5, 0.5],
    children: [
      group("g0", [tab("a.ts"), tab("b.ts")]),
      group("g1", [tab("a.ts"), tab("c.ts")], "c.ts"),
    ],
  },
  "g0",
);

test("holds one lease per open path, visible only where a group shows it, and lets go of closed paths", () => {
  const fake = fakeRegistry();
  const bridge = registryBuffers(fake.registry, "m1/t1");
  bridge.sync(twoGroups);
  expect(fake.live("a.ts").map((hold) => hold.visible)).toEqual([true]);
  expect(fake.live("b.ts").map((hold) => hold.visible)).toEqual([false]);
  expect(fake.live("c.ts").map((hold) => hold.visible)).toEqual([true]);

  bridge.sync(layoutOf(group("g0", [tab("b.ts")], "b.ts"), "g0"));
  expect(fake.live("a.ts")).toEqual([]);
  expect(fake.live("c.ts")).toEqual([]);
  expect(fake.live("b.ts").map((hold) => hold.visible)).toEqual([true]);

  bridge.dispose();
  expect(fake.live("b.ts")).toEqual([]);
});

test("a clash from this thread's agent names the agent with its mark; a deletion raises no Merge", () => {
  const fake = fakeRegistry();
  const bridge = registryBuffers(fake.registry, "m1/t1", {
    providerOf: (agent) => (agent === "Claude Code" ? "claude" : undefined),
  });
  bridge.sync(twoGroups);
  const by = { kind: "agent", agent: "Claude Code", threadId: "t1" } as const;
  fake.setSnapshot("a.ts", {
    dirty: true,
    clash: { kind: "changed", theirs: { text: "", version: "v2" }, by },
  });
  expect(bridge.facts("a.ts")).toMatchObject({
    unsaved: true,
    clash: { merging: false },
    changedBy: { name: "Claude Code", provider: "claude" },
  });

  fake.setSnapshot("a.ts", { clash: { kind: "merging", theirs: { text: "", version: "v2" }, by } });
  expect(bridge.facts("a.ts").clash).toEqual({ merging: true });

  fake.setSnapshot("a.ts", { clash: { kind: "deleted", by } });
  expect(bridge.facts("a.ts").clash).toBeUndefined();
});

test("another thread's change is credited to that thread's title", () => {
  const fake = fakeRegistry();
  const bridge = registryBuffers(fake.registry, "m1/t1");
  bridge.sync(twoGroups);
  fake.setSnapshot("b.ts", {
    dirty: true,
    clash: {
      kind: "changed",
      theirs: { text: "", version: "v2" },
      by: { kind: "thread", threadId: "t2", title: "Fix relay loop", agent: "Codex" },
    },
  });
  expect(bridge.facts("b.ts").changedBy).toEqual({ name: "Fix relay loop", provider: undefined });
});

function Mounted(props: { fake: ReturnType<typeof fakeRegistry> }) {
  const [layout, setLayout] = useState(twoGroups);
  const buffers = useRegistryBuffers(props.fake.registry, "m1/t1", layout);
  return (
    <Deck
      layout={layout}
      onLayoutChange={setLayout}
      newGroupId={() => "g9"}
      buffers={buffers}
      renderEditor={(editor) => <div>{`editing ${editor.path}`}</div>}
      onMerge={() => {}}
      onCompare={() => {}}
    />
  );
}

test("the Deck raises the notice when the registry reports the disk moved under unsaved edits", () => {
  const fake = fakeRegistry();
  render(<Mounted fake={fake} />);
  expect(screen.getAllByText("editing a.ts")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();

  act(() =>
    fake.setSnapshot("a.ts", {
      dirty: true,
      clash: {
        kind: "changed",
        theirs: { text: "", version: "v2" },
        by: { kind: "agent", agent: "Claude Code", threadId: "t1" },
      },
    }),
  );
  expect(screen.getByText("Claude Code also changed this file.")).toBeTruthy();
  // Both groups' tabs of the file read the one buffer.
  expect(screen.getAllByRole("button", { name: "Close a.ts, unsaved" })).toHaveLength(2);
});
