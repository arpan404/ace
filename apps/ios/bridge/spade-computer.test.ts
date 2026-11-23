import { parseSpadeComputer } from "@ace/ui-core/spade-chat";
import { fakeFileRevision } from "@ace/fake-daemon";
import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { spadeComputerRow } from "./spade-computer-rows.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * A bot's computer on the iPhone (#2547): who has it, Take over and Hand back, and its files
 * browsed and changed, each write refused when the bot changed the file meanwhile.
 */

const computer = (fields: Record<string, unknown>) => {
  const parsed = parseSpadeComputer({ driver: "bot", mode: "cowork", surfaces: [], ...fields });
  if (!parsed) throw new Error("not a computer");
  return parsed;
};

async function withBot(files: Record<string, string> = {}) {
  const host = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.files.set("writer", files);
  });
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  return host;
}

test("in cowork the person's input goes in with no take-over, and the line stays quiet while the bot rests", () => {
  const row = spadeComputerRow(computer({}), "Writer", false);
  expect(row.mayAct).toBe(true);
  expect(row.drive.terminal).toEqual({
    sentence: "Writer isn't using the terminal now.",
    face: false,
    action: null,
  });
  expect(row.drive.files.sentence).toBe("Writer isn't using the computer now.");
  expect(row.used).toEqual(["terminal", "files"]);
});

test("a bot at work on its browser shows its face with Take over, and a surface kept live after work isn't in use", () => {
  const using = computer({ surfaces: [{ kind: "browser", live: true, title: "Release notes" }] });
  expect(spadeComputerRow(using, "Writer", true).drive.browser).toEqual({
    sentence: "Writer is using the browser",
    face: true,
    action: "take-over",
  });
  const resting = spadeComputerRow(using, "Writer", false);
  expect(resting.surfaces[0]?.live).toBe(false);
  expect(resting.drive.browser.action).toBeNull();
});

test("while the person acts in cowork the busy bot waits for them", () => {
  const row = spadeComputerRow(
    computer({ surfaces: [{ kind: "screen", live: true, person_active: true }] }),
    "Writer",
    true,
  );
  expect(row.drive.screen.sentence).toBe("Writer is waiting for you");
});

test("after a take-over input waits until the bot's work has stopped, then the person drives", () => {
  const stopping = spadeComputerRow(
    computer({ driver: "person", mode: "exclusive", stopping: true }),
    "Writer",
    true,
  );
  expect(stopping.mayAct).toBe(false);
  expect(stopping.drive.terminal).toEqual({
    sentence: "Stopping Writer…",
    face: false,
    action: "hand-back",
  });
  const driving = spadeComputerRow(
    computer({ driver: "person", mode: "exclusive" }),
    "Writer",
    true,
  );
  expect(driving.mayAct).toBe(true);
  expect(driving.driving).toBe(true);
  expect(driving.drive.browser.sentence).toBe("You have the browser");
});

test("Take over gives the person the computer and Hand back returns it to the bot", async () => {
  const { ask, api } = await withBot();

  const taken = await ask({ type: "spade.computer.take", agentId: "writer", take: true });
  expect(taken).toMatchObject({ ok: true, computer: { driving: true, mayAct: true } });
  expect(api.computer.driver("writer")).toBe("person");

  const back = await ask({ type: "spade.computer.take", agentId: "writer", take: false });
  expect(back).toMatchObject({ ok: true, computer: { driving: false } });
  expect(api.computer.driver("writer")).toBe("bot");
});

test("a folder lists the bot's files without Spade's own bookkeeping, in Spade's order, and opens a level down", async () => {
  const { ask } = await withBot({
    "notes.md": "# Notes",
    "src/app.ts": "export {}",
    ".spade/state.json": "{}",
  });

  const top = await ask({ type: "spade.files.folder", agentId: "writer", path: "" });
  if (!("folder" in top)) throw new Error(JSON.stringify(top));
  expect(top.folder.entries.map((entry) => [entry.name, entry.kind])).toEqual([
    ["src", "folder"],
    ["notes.md", "file"],
  ]);
  const src = await ask({ type: "spade.files.folder", agentId: "writer", path: "src" });
  expect(src).toMatchObject({ ok: true, folder: { entries: [{ path: "src/app.ts" }] } });
});

test("an edit saves over the revision it opened and the next save follows on from it", async () => {
  const { ask, api } = await withBot({ "notes.md": "one" });

  const opened = await ask({ type: "spade.files.file", agentId: "writer", path: "notes.md" });
  if (!("file" in opened)) throw new Error(JSON.stringify(opened));
  expect(opened.file).toMatchObject({ text: "one", revision: fakeFileRevision("one") });

  const saved = await ask({
    type: "spade.files.save",
    agentId: "writer",
    path: "notes.md",
    text: "two",
    base: opened.file.revision ?? undefined,
  });
  expect(saved).toEqual({ ok: true, revision: fakeFileRevision("two") });
  const again = await ask({
    type: "spade.files.save",
    agentId: "writer",
    path: "notes.md",
    text: "three",
    base: fakeFileRevision("two"),
  });
  expect(again).toMatchObject({ ok: true });
  expect(api.files.get("writer")?.["notes.md"]).toBe("three");
});

test("saving over a file the bot changed meanwhile asks first: nothing is written until the person chooses", async () => {
  const { ask, api } = await withBot({ "notes.md": "one" });
  const opened = await ask({ type: "spade.files.file", agentId: "writer", path: "notes.md" });
  if (!("file" in opened)) throw new Error(JSON.stringify(opened));
  api.computer.botWrites("writer", "notes.md", "the bot's");

  const refused = await ask({
    type: "spade.files.save",
    agentId: "writer",
    path: "notes.md",
    text: "mine",
    base: opened.file.revision ?? undefined,
  });
  expect(refused).toMatchObject({ ok: false, changed: true, title: "Couldn't save notes.md" });
  expect(api.files.get("writer")?.["notes.md"]).toBe("the bot's");

  // Keep mine: saved over the bot's revision, the one the person was just shown.
  const theirs = await ask({ type: "spade.files.file", agentId: "writer", path: "notes.md" });
  if (!("file" in theirs)) throw new Error(JSON.stringify(theirs));
  const kept = await ask({
    type: "spade.files.save",
    agentId: "writer",
    path: "notes.md",
    text: "mine",
    base: theirs.file.revision ?? undefined,
  });
  expect(kept).toMatchObject({ ok: true });
  expect(api.files.get("writer")?.["notes.md"]).toBe("mine");
});

test("a file uploaded from the phone lands in the folder open, and New folder makes one there", async () => {
  const { ask, api, stage } = await withBot({ "src/app.ts": "export {}" });
  const file = stage("readme.txt", "text/plain", new TextEncoder().encode("hello"));

  expect(await ask({ type: "spade.files.upload", agentId: "writer", folder: "src", file })).toEqual(
    { ok: true },
  );
  expect(api.files.get("writer")?.["src/readme.txt"]).toBe("hello");
  expect(await ask({ type: "spade.files.mkdir", agentId: "writer", path: "src/lib" })).toEqual({
    ok: true,
  });
  const src = await ask({ type: "spade.files.folder", agentId: "writer", path: "src" });
  if (!("folder" in src)) throw new Error(JSON.stringify(src));
  expect(src.folder.entries.map((entry) => entry.name).toSorted()).toEqual([
    "app.ts",
    "lib",
    "readme.txt",
  ]);
});

test("a rename with folders in it moves the file, and one the bot changed since is refused", async () => {
  const { ask, api } = await withBot({ "draft.md": "a", "other.md": "b" });
  const seen = await ask({ type: "spade.files.revision", agentId: "writer", path: "draft.md" });
  if (!("revision" in seen)) throw new Error(JSON.stringify(seen));

  const moved = await ask({
    type: "spade.files.move",
    agentId: "writer",
    from: "draft.md",
    to: "done/final.md",
    base: seen.revision ?? undefined,
  });
  expect(moved).toEqual({ ok: true });
  expect(api.files.get("writer")).toMatchObject({ "done/final.md": "a" });

  const other = await ask({ type: "spade.files.revision", agentId: "writer", path: "other.md" });
  if (!("revision" in other)) throw new Error(JSON.stringify(other));
  api.computer.botWrites("writer", "other.md", "changed");
  const refused = await ask({
    type: "spade.files.move",
    agentId: "writer",
    from: "other.md",
    to: "renamed.md",
    base: other.revision ?? undefined,
  });
  expect(refused).toMatchObject({ ok: false, changed: true });
  expect(api.files.get("writer")?.["other.md"]).toBe("changed");
});

test("delete removes the file it was asked about, and says so when it is already gone", async () => {
  const { ask, api } = await withBot({ "old.log": "x" });
  const seen = await ask({ type: "spade.files.revision", agentId: "writer", path: "old.log" });
  if (!("revision" in seen)) throw new Error(JSON.stringify(seen));

  expect(
    await ask({
      type: "spade.files.delete",
      agentId: "writer",
      path: "old.log",
      base: seen.revision ?? undefined,
    }),
  ).toEqual({ ok: true });
  expect(api.files.get("writer")).toEqual({});
  expect(
    await ask({ type: "spade.files.revision", agentId: "writer", path: "old.log" }),
  ).toMatchObject({ ok: false, gone: true });
});

test("an upload never overwrites a file the bot makes after the phone looked", async () => {
  const { ask, api, stage, staged } = await withBot({});
  const file = stage("notes.md", "text/markdown", new TextEncoder().encode("mine"));
  // The bot writes the file while the phone reads the picked one's bytes, after the check.
  const read = staged.get.bind(staged);
  staged.get = (id: string) => {
    if (api.files.get("writer")?.["notes.md"] === undefined)
      api.computer.botWrites("writer", "notes.md", "the bot's");
    return read(id);
  };

  const answer = await ask({ type: "spade.files.upload", agentId: "writer", folder: "", file });

  expect(answer).toMatchObject({ ok: false, changed: true, title: "Couldn't upload notes.md" });
  expect(api.files.get("writer")?.["notes.md"]).toBe("the bot's");
});

test("an upload replaces a file only as the phone saw it", async () => {
  const { ask, api, stage } = await withBot({ "notes.md": "old" });
  const file = stage("notes.md", "text/markdown", new TextEncoder().encode("mine"));

  expect(await ask({ type: "spade.files.upload", agentId: "writer", folder: "", file })).toEqual({
    ok: true,
  });
  expect(api.files.get("writer")?.["notes.md"]).toBe("mine");
});

test("a file Spade gives no revision of can't be replaced, renamed or deleted from the phone", async () => {
  const { ask, api, stage } = await withBot({ "big.bin": "x" });
  api.unrevised.add("big.bin");

  expect(
    await ask({ type: "spade.files.revision", agentId: "writer", path: "big.bin" }),
  ).toMatchObject({ ok: false, title: "Spade can't check this file" });
  const file = stage("big.bin", "application/octet-stream", new Uint8Array([1]));
  expect(
    await ask({ type: "spade.files.upload", agentId: "writer", folder: "", file }),
  ).toMatchObject({ ok: false, title: "Couldn't upload big.bin" });
  expect(api.files.get("writer")?.["big.bin"]).toBe("x");
});
