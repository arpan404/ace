import { defaultExplorer, type EditorLayout } from "@ace/ui-core/editor-workbench";
import { beforeAll, expect, test } from "vitest";
import { createBufferRegistry, editorBuffers } from "@/features/editor-workbench/index.ts";
import {
  fakeDisk,
  inlineMerge,
  manualTime,
  memoryDrafts,
  ready,
  settle,
} from "@/features/editor-workbench/buffers/test-support.ts";
import { saveFile, saveQueued, type EditorActionsHost } from "./editor-actions.ts";

/*
 * Saves asked for while the daemon is offline run once it is back: only the files the person
 * saved, never every unsaved one (a reverted file waits for its own Save).
 */

beforeAll(ready);

const root = "m1/t1";
const tab = (path: string) => ({ path, preview: false, pinned: false });

test("reconnecting saves only the files saved while offline", async () => {
  const disk = fakeDisk({ "a.ts": "a\n", "b.ts": "b\n" }, root);
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: memoryDrafts().store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
    attribute: () => ({ kind: "unknown" }),
  });
  const buffers = editorBuffers(registry, root);
  const layout: EditorLayout = {
    explorer: defaultExplorer,
    closed: [],
    root: { kind: "group", id: "g1", tabs: [tab("a.ts"), tab("b.ts")], active: "a.ts", mru: [] },
    focused: "g1",
  };
  buffers.sync(layout);
  await settle();
  let online = false;
  const queued: EditorActionsHost["queued"] = new Map();
  const problems: unknown[] = [];
  const host: EditorActionsHost = {
    buffers,
    layout: () => layout,
    change: () => {},
    online: () => online,
    problem: (problem) => problems.push(problem),
    queued,
  };
  const a = buffers.buffer("a.ts");
  const b = buffers.buffer("b.ts");
  if (!a || !b) throw new Error("not open");
  a.editLines([{ start: 0, end: 1, text: "A\n" }]);
  // b.ts: a Revert, unsaved, waiting for its own Save.
  b.editLines([{ start: 0, end: 1, text: "B\n" }], { manualSave: true });

  expect(await saveFile(host, "a.ts")).toBe(false);
  expect([...(queued?.keys() ?? [])]).toEqual(["a.ts"]);

  online = true;
  await saveQueued(host);

  expect(disk.text("a.ts")).toBe("A\n");
  expect(disk.text("b.ts")).toBe("b\n");
  expect(queued?.size).toBe(0);

  // Saved offline again, then a Revert in that same file before the daemon is back: the queued
  // save was for other text, so nothing is written and the file waits for a fresh Save.
  online = false;
  a.editLines([{ start: 0, end: 1, text: "AA\n" }]);
  expect(await saveFile(host, "a.ts")).toBe(false);
  a.editLines([{ start: 0, end: 1, text: "reverted\n" }], { manualSave: true });
  online = true;
  await saveQueued(host);

  expect(disk.text("a.ts")).toBe("A\n");
  expect(a.snapshot()).toMatchObject({ dirty: true, manualSave: true });
  expect(problems.at(-1)).toMatchObject({ path: "a.ts" });
});
