import { beforeAll, describe, expect, it } from "vitest";
import type { Author } from "./attribution.ts";
import { createBufferRegistry } from "./registry.ts";
import { fakeDisk, inlineMerge, manualTime, memoryDrafts, ready, settle } from "./test-support.ts";
import type { DocumentView } from "@/features/editor";
import type { MergePort, TextBuffer } from "./types.ts";

beforeAll(ready);

const file = { root: "m1/t1", path: "places.ts" };
const claude: Author = { kind: "agent", agent: "Claude Code", threadId: "t1" };

/** The merge worker, failing its next diff or merge when told to (a worker that crashed). */
function failingMerge(inner: MergePort) {
  const fail = { lineChanges: false, merge3: false, gate: undefined as Promise<void> | undefined };
  const port: MergePort = {
    async merge3(base, mine, theirs) {
      if (fail.gate) await fail.gate;
      if (fail.merge3) {
        fail.merge3 = false;
        throw new Error("The merge worker stopped.");
      }
      return inner.merge3(base, mine, theirs);
    },
    async lineChanges(before, after) {
      if (fail.lineChanges) {
        fail.lineChanges = false;
        throw new Error("The merge worker stopped.");
      }
      return inner.lineChanges(before, after);
    },
  };
  return { port, fail };
}

async function setup(text: string) {
  const disk = fakeDisk({ "places.ts": text });
  const drafts = memoryDrafts();
  const merge = inlineMerge();
  const failing = failingMerge(merge.port);
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: drafts.store,
    merge: failing.port,
    now: time.now,
    schedule: time.schedule,
    ready,
    attribute: () => claude,
  });
  const lease = registry.open(file);
  lease.setVisible(true);
  await settle();
  return { disk, drafts, merge, fail: failing.fail, time, registry, buffer: lease.buffer };
}

function replaceLine(buffer: TextBuffer, line: number, text: string) {
  const doc = buffer.document();
  if (!doc) throw new Error("no document");
  doc.apply([
    {
      range: { start: { line, column: 0 }, end: { line, column: doc.line(line).length } },
      text,
    },
  ]);
  buffer.edited();
}

/** An agent writes the file and the watcher reports it. */
async function agentWrites(context: Awaited<ReturnType<typeof setup>>, text: string) {
  context.disk.write("places.ts", text);
  context.registry.diskChanged(file);
  await settle();
}

describe("saving", () => {
  it("writes through the expected version and leaves the buffer clean", async () => {
    const context = await setup("a\nb\n");
    replaceLine(context.buffer, 0, "A");

    expect(await context.buffer.save()).toEqual({ kind: "saved", version: "v2" });

    expect(context.disk.text("places.ts")).toBe("A\nb\n");
    expect(context.buffer.snapshot()).toMatchObject({ dirty: false, version: "v2" });
    expect(await context.buffer.save()).toEqual({ kind: "unchanged" });
  });

  it("bases the buffer on the saved text, which the gutter compares against", async () => {
    const context = await setup("a\nb\n");
    replaceLine(context.buffer, 0, "A");
    // Unsaved: the base is still the disk's text.
    expect(context.buffer.baseText()).toBe("a\nb\n");

    await context.buffer.save();
    expect(context.buffer.baseText()).toBe("A\nb\n");
  });

  it("that meets a version clash overwrites nothing and raises the clash", async () => {
    const context = await setup("a\nb\n");
    replaceLine(context.buffer, 0, "A");
    context.disk.write("places.ts", "a\nB\n");

    expect(await context.buffer.save()).toEqual({ kind: "clash" });

    expect(context.disk.text("places.ts")).toBe("a\nB\n");
    expect(context.buffer.snapshot().clash).toEqual({
      kind: "changed",
      theirs: { text: "a\nB\n", version: "v2" },
      by: claude,
    });
    expect(await context.buffer.save()).toEqual({ kind: "clash" });
  });

  it("replaces the disk's text only when asked", async () => {
    const context = await setup("a\nb\n");
    replaceLine(context.buffer, 0, "A");
    await agentWrites(context, "a\nB\n");

    expect(await context.buffer.replace("v2")).toEqual({ kind: "saved", version: "v3" });

    expect(context.disk.text("places.ts")).toBe("A\nb\n");
    expect(context.buffer.snapshot()).toMatchObject({ dirty: false, clash: undefined });
  });

  it("a Replace confirmed for one disk version overwrites nothing once the agent writes again", async () => {
    const context = await setup("a\nb\n");
    replaceLine(context.buffer, 0, "A");
    await agentWrites(context, "a\nB\n");
    // The person is asked about v2 ("Replace Claude Code's changes?") …
    expect(context.buffer.snapshot().clash).toMatchObject({ theirs: { version: "v2" } });
    // … and while the question is open, the agent writes again.
    await agentWrites(context, "a\nB\nC\n");

    expect(await context.buffer.replace("v2")).toEqual({ kind: "clash" });

    // The agent's newer write is untouched, and the clash now names it: a new decision.
    expect(context.disk.text("places.ts")).toBe("a\nB\nC\n");
    expect(context.buffer.snapshot().clash).toMatchObject({ theirs: { version: "v3" } });
    expect(context.buffer.document()?.text()).toBe("A\nb\n");
  });

  it("a Replace confirmed for a deleted file overwrites nothing once the file is back", async () => {
    const context = await setup("a\n");
    replaceLine(context.buffer, 0, "A");
    context.disk.remove("places.ts");
    context.registry.diskChanged(file);
    await settle();
    await agentWrites(context, "b\n");

    expect(await context.buffer.replace(null)).toEqual({ kind: "clash" });
    expect(context.disk.text("places.ts")).toBe("b\n");
  });
});

describe("a file changing on disk", () => {
  it("reloads a clean buffer in place, keeping the caret on its text", async () => {
    const context = await setup("a\nb\nc\n");
    const doc = context.buffer.document();
    doc?.setSelections([{ anchor: { line: 2, column: 1 }, head: { line: 2, column: 1 } }]);
    const events: string[] = [];
    context.buffer.subscribe((event) => events.push(event.type));

    await agentWrites(context, "new\na\nb\nc\n");

    expect(doc?.text()).toBe("new\na\nb\nc\n");
    expect(doc?.selections()).toEqual([
      { anchor: { line: 3, column: 1 }, head: { line: 3, column: 1 } },
    ]);
    expect(context.buffer.snapshot()).toMatchObject({ dirty: false, version: "v2" });
    expect(events).toContain("replaced");
  });

  it("under unsaved edits raises the clash at once, naming who changed it", async () => {
    const context = await setup("a\nb\n");
    replaceLine(context.buffer, 0, "A");

    await agentWrites(context, "a\nB\n");

    expect(context.buffer.document()?.text()).toBe("A\nb\n");
    expect(context.buffer.snapshot().clash).toMatchObject({ kind: "changed", by: claude });
  });

  it("deleted under unsaved edits keeps the edits, and saving writes the file again", async () => {
    const context = await setup("a\n");
    replaceLine(context.buffer, 0, "A");
    context.disk.remove("places.ts");
    context.registry.diskChanged(file);
    await settle();

    expect(context.buffer.snapshot().clash).toEqual({ kind: "deleted", by: claude });
    expect(await context.buffer.replace(null)).toMatchObject({ kind: "saved" });
    expect(context.disk.text("places.ts")).toBe("A\n");
  });
});

describe("merging", () => {
  it("lands a clean merge as one undoable step and keeps it unsaved for review", async () => {
    const context = await setup("a\nb\nc\nd\n");
    replaceLine(context.buffer, 0, "mine");
    await agentWrites(context, "a\nb\nc\ntheirs\n");

    await context.buffer.merge();

    const doc = context.buffer.document();
    expect(doc?.text()).toBe("mine\nb\nc\ntheirs\n");
    expect(context.buffer.snapshot()).toMatchObject({
      dirty: true,
      clash: undefined,
      version: "v2",
    });
    expect(context.disk.text("places.ts")).toBe("a\nb\nc\ntheirs\n");

    doc?.undo();
    expect(doc?.text()).toBe("mine\nb\nc\nd\n");
    doc?.redo();
    expect(await context.buffer.save()).toEqual({ kind: "saved", version: "v3" });
    expect(context.disk.text("places.ts")).toBe("mine\nb\nc\ntheirs\n");
  });

  it("does not move a caret between the blocks it changes", async () => {
    const context = await setup("a\nb\nc\nd\ne\n");
    replaceLine(context.buffer, 0, "mine");
    const doc = context.buffer.document();
    doc?.setSelections([{ anchor: { line: 2, column: 1 }, head: { line: 2, column: 1 } }]);
    await agentWrites(context, "a\nb\nc\nd\ntheirs\nmore\n");

    await context.buffer.merge();

    expect(doc?.selections()).toEqual([
      { anchor: { line: 2, column: 1 }, head: { line: 2, column: 1 } },
    ]);
  });

  it("turns overlapping blocks into a conflict with both sides, and save waits for answers", async () => {
    const context = await setup("a\nb\nc\nd\ne\n");
    replaceLine(context.buffer, 1, "mine b");
    replaceLine(context.buffer, 4, "mine e");
    await agentWrites(context, "a\ntheirs b\nc\nd\ntheirs e\n");

    await context.buffer.merge();

    const clash = context.buffer.snapshot().clash;
    expect(clash).toMatchObject({
      kind: "conflict",
      chunks: [
        { kind: "clean", text: "a\n" },
        { kind: "conflict", base: "b\n", mine: "mine b\n", theirs: "theirs b\n" },
        { kind: "clean", text: "c\nd\n" },
        { kind: "conflict", base: "e\n", mine: "mine e\n", theirs: "theirs e\n" },
      ],
      answers: [undefined, undefined],
    });
    expect(await context.buffer.save()).toEqual({ kind: "unanswered" });

    await context.buffer.answer(0, "theirs", context.buffer.snapshot().clash);
    expect(context.buffer.snapshot().clash).toMatchObject({ answers: ["theirs", undefined] });
    await context.buffer.answer(1, "mine", context.buffer.snapshot().clash);

    expect(context.buffer.document()?.text()).toBe("a\ntheirs b\nc\nd\nmine e\n");
    expect(context.buffer.snapshot()).toMatchObject({ clash: undefined, dirty: true });
    expect(await context.buffer.save()).toEqual({ kind: "saved", version: "v3" });
  });

  it("ignores choices while an answered conflict is landing, and answers for a conflict since replaced", async () => {
    const context = await setup("a\nb\nc\nd\ne\n");
    replaceLine(context.buffer, 1, "mine b");
    replaceLine(context.buffer, 4, "mine e");
    await agentWrites(context, "a\ntheirs b\nc\nd\ntheirs e\n");
    await context.buffer.merge();
    const asked = context.buffer.snapshot().clash;

    void context.buffer.answer(0, "theirs", asked);
    const landing = context.buffer.answer(1, "mine", context.buffer.snapshot().clash);
    // The last answer is landing: the blocks are shown as settled, and a late change of mind
    // (to the first block) changes nothing.
    expect(context.buffer.snapshot().clash).toMatchObject({ applying: true });
    void context.buffer.answer(0, "mine", context.buffer.snapshot().clash);
    void context.buffer.answerAll("mine", context.buffer.snapshot().clash);
    await landing;
    await settle();

    expect(context.buffer.document()?.text()).toBe("a\ntheirs b\nc\nd\nmine e\n");
    expect(context.buffer.snapshot().clash).toBeUndefined();
  });

  it("an answer for a conflict that another has replaced changes nothing in the new one", async () => {
    const context = await setup("a\nb\nc\nd\ne\n");
    replaceLine(context.buffer, 1, "mine b");
    replaceLine(context.buffer, 4, "mine e");
    await agentWrites(context, "a\ntheirs b\nc\nd\ntheirs e\n");
    await context.buffer.merge();
    const old = context.buffer.snapshot().clash;
    // The agent writes again; merging that gives a new conflict, now the one shown.
    await agentWrites(context, "a\nnewer b\nc\nd\nnewer e\n");
    await context.buffer.merge();
    const current = context.buffer.snapshot().clash;
    expect(current).toMatchObject({ kind: "conflict", theirs: { version: "v3" } });
    expect(current).not.toBe(old);

    // A click on the old conflict's block arrives late.
    await context.buffer.answer(0, "theirs", old);
    await context.buffer.answerAll("theirs", old);

    expect(context.buffer.snapshot().clash).toBe(current);
    expect(context.buffer.snapshot().clash).toMatchObject({ answers: [undefined, undefined] });
  });

  it("a landing that fails gives the choices back, with the answers and the person's text kept", async () => {
    const context = await setup("a\nb\nc\nd\ne\n");
    replaceLine(context.buffer, 1, "mine b");
    replaceLine(context.buffer, 4, "mine e");
    await agentWrites(context, "a\ntheirs b\nc\nd\ntheirs e\n");
    await context.buffer.merge();
    await context.buffer.answer(0, "theirs", context.buffer.snapshot().clash);

    context.fail.lineChanges = true;
    await context.buffer.answer(1, "mine", context.buffer.snapshot().clash);
    await settle();

    const clash = context.buffer.snapshot().clash;
    expect(clash).toMatchObject({ kind: "conflict", answers: ["theirs", "mine"] });
    expect(clash && "applying" in clash ? clash.applying : undefined).toBeUndefined();
    expect(context.buffer.document()?.text()).toBe("a\nmine b\nc\nd\nmine e\n");
    expect(await context.buffer.save()).toEqual({ kind: "unanswered" });

    // Choosing again lands it.
    await context.buffer.answerAll("mine", context.buffer.snapshot().clash);
    expect(context.buffer.snapshot().clash).toBeUndefined();
    expect(context.buffer.document()?.text()).toBe("a\nmine b\nc\nd\nmine e\n");
  });

  it("a merge that fails after a newer disk change merges the newer one, never the older", async () => {
    const context = await setup("a\nb\nc\n");
    replaceLine(context.buffer, 0, "mine a");
    await agentWrites(context, "a\nb\ntheirs c\n");
    const gate = Promise.withResolvers<void>();
    context.fail.gate = gate.promise;
    context.fail.merge3 = true;
    const merging = context.buffer.merge();
    await settle();
    // A newer version lands while the (failing) merge runs.
    await agentWrites(context, "a\nb\ntheirs c\nnewer d\n");
    context.fail.gate = undefined;
    gate.resolve();
    await merging;
    await settle();

    expect(context.buffer.snapshot().clash).toBeUndefined();
    expect(context.buffer.document()?.text()).toBe("mine a\nb\ntheirs c\nnewer d\n");
  });

  it("answers every block at once with one choice", async () => {
    const context = await setup("a\nb\nc\nd\ne\n");
    replaceLine(context.buffer, 1, "mine b");
    replaceLine(context.buffer, 4, "mine e");
    await agentWrites(context, "a\ntheirs b\nc\nd\ntheirs e\n");
    await context.buffer.merge();

    await context.buffer.answerAll("theirs", context.buffer.snapshot().clash);

    expect(context.buffer.document()?.text()).toBe("a\ntheirs b\nc\nd\ntheirs e\n");
    expect(context.buffer.snapshot().clash).toBeUndefined();
  });

  it("a disk change while answers land is never covered by the older answers", async () => {
    const context = await setup("a\nb\nc\n");
    replaceLine(context.buffer, 1, "mine b");
    await agentWrites(context, "a\ntheirs b\nc\n");
    await context.buffer.merge();
    context.merge.hold();
    // Typing while the answer lands makes the loop merge again (held) …
    const landing = context.buffer.answer(0, "mine", context.buffer.snapshot().clash);
    replaceLine(context.buffer, 0, "A");
    // … and the agent writes once more meanwhile.
    await agentWrites(context, "a\ntheirs b\nc\nnewer\n");
    context.merge.release();
    await landing;
    await settle();

    // The newer write is not taken as answered: it waits for its own Merge.
    expect(context.buffer.snapshot().clash).toMatchObject({ theirs: { version: "v3" } });
    expect(context.buffer.document()?.text()).not.toContain("newer");
    expect(context.buffer.document()?.text()).toContain("mine b");
  });

  it("keeps what was typed while a conflict waited for answers", async () => {
    const context = await setup("a\nb\nc\nd\ne\n");
    replaceLine(context.buffer, 1, "mine b");
    await agentWrites(context, "a\ntheirs b\nc\nd\ne\n");
    await context.buffer.merge();

    replaceLine(context.buffer, 4, "typed meanwhile");
    await context.buffer.answer(0, "theirs", context.buffer.snapshot().clash);

    expect(context.buffer.document()?.text()).toBe("a\ntheirs b\nc\nd\ntyped meanwhile\n");
  });

  it("that the person's text already matches leaves the buffer saved", async () => {
    const context = await setup("a\nb\n");
    replaceLine(context.buffer, 1, "same");
    await agentWrites(context, "a\nsame\n");

    await context.buffer.merge();

    expect(context.buffer.snapshot()).toMatchObject({ dirty: false, clash: undefined });
    expect(await context.drafts.store.get(file)).toBeUndefined();
  });

  it("runs off the editor's path: typing during a merge is merged too", async () => {
    const context = await setup("a\nb\nc\nd\n");
    replaceLine(context.buffer, 0, "mine");
    await agentWrites(context, "a\nb\nc\ntheirs\n");
    context.merge.hold();

    const merging = context.buffer.merge();
    await settle();
    expect(context.buffer.snapshot().clash).toMatchObject({ kind: "merging" });
    replaceLine(context.buffer, 1, "typed during the merge");
    context.merge.release();
    await merging;

    expect(context.buffer.document()?.text()).toBe("mine\ntyped during the merge\nc\ntheirs\n");
  });

  it("is persisted with its new base, so a reload does not raise the clash again", async () => {
    const context = await setup("a\nb\nc\nd\n");
    replaceLine(context.buffer, 0, "mine");
    await agentWrites(context, "a\nb\nc\ntheirs\n");
    await context.buffer.merge();
    await context.registry.flushDrafts();

    expect(await context.drafts.store.get(file)).toEqual({
      text: "mine\nb\nc\ntheirs\n",
      original: "a\nb\nc\ntheirs\n",
      version: "v2",
    });
  });
});

/** A mounted view that only lends its edit path. */
const mounted = (edit: DocumentView["edit"]): DocumentView => ({
  edit,
  before: () => {},
  applied: () => {},
});

describe("a mounted view", () => {
  it("hears a merge through its own edit path, as the changed lines, and stays unsaved", async () => {
    const context = await setup("a\nb\nc\nd\n");
    const view = context.buffer.view();
    if (!view) throw new Error("no view");
    const heard: { firstLine: number; removedLines: number; insertedLines: number }[] = [];
    const detach = view.attach(
      mounted((run) => {
        const applied = run(view.doc);
        if (applied) heard.push(...applied.spans);
        // The view's own edit callback, as CodeEditor's onEdit sends it.
        context.buffer.edited();
        return applied !== undefined;
      }),
    );
    replaceLine(context.buffer, 0, "mine");
    await agentWrites(context, "a\nb\nc\ntheirs\n");

    await context.buffer.merge();
    detach();

    // Line 3 and the start of line 4, where the replaced line ends.
    expect(heard).toEqual([{ firstLine: 3, removedLines: 2, insertedLines: 2 }]);
    expect(view.doc.text()).toBe("mine\nb\nc\ntheirs\n");
    expect(context.buffer.view()).toBe(view);
    expect(context.buffer.snapshot()).toMatchObject({ dirty: true, clash: undefined });
  });

  it("hears a reload of a clean file without the buffer turning unsaved", async () => {
    const context = await setup("a\nb\n");
    const view = context.buffer.view();
    if (!view) throw new Error("no view");
    view.attach(
      mounted((run) => {
        const applied = run(view.doc);
        context.buffer.edited();
        return applied !== undefined;
      }),
    );

    await agentWrites(context, "a\nB\n");
    await context.time.advance(400);

    expect(view.doc.text()).toBe("a\nB\n");
    expect(context.buffer.snapshot()).toMatchObject({ dirty: false, version: "v2" });
    expect(await context.drafts.store.get(file)).toBeUndefined();
  });
});
