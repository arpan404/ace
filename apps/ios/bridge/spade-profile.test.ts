import { faceForId, storedBotFace } from "@ace/ui-core/bot-face";
import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { NativeSpadeRequest } from "./spade-requests.ts";
import { setUp } from "./spade-test-host.ts";
import type { SpadeProfileRow } from "./spade-profile.ts";

/*
 * A bot's profile sheet on the iPhone: Details, Library and Computer read from Spade, each part
 * on its own, and the task the person rewrites saved back.
 */

test("a bot's profile shows its task, model, routines, what it keeps and what its computer did", async () => {
  const { ask, patches } = await setUp((fake) => {
    fake.addAgent({
      id: "writer",
      name: "Writer",
      task: "Draft the release notes every Friday.",
      model: "anthropic/claude-sonnet-4-5",
    });
    fake.routines.agentRoute("POST", "writer", "routines", {
      name: "Friday notes",
      instruction: "Draft them",
      trigger: { kind: "schedule", schedule: "weekdays at 9:00" },
    });
    fake.notes.add({ text: "Keep it under a page.", agent: "writer" });
    fake.notes.suggest({ text: "From a web page", agent: "writer" });
    fake.knowledge.add({ agent: "writer", title: "House style", body: "Short lines." });
    fake.files.set("writer", { "draft.md": "# Notes", ".spade/state.json": "{}" });
    fake.skillStore = {
      ace: false,
      skills: [{ id: "s1", name: "Release notes", origin: "spade", written_by: ["writer"] }],
    };
    fake.computer.use("writer", { kind: "terminal", live: false, title: "bun test", last: 1 });
    fake.services.start("writer", { name: "Preview", command: "bun run dev" });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);

  const answer = await ask({ type: "spade.profile", agentId: "writer" });

  if (!("profile" in answer)) throw new Error(JSON.stringify(answer));
  const profile: SpadeProfileRow = answer.profile;
  expect(profile.name).toBe("Writer");
  expect(profile.face).toEqual({
    main: false,
    initial: "W",
    away: false,
    character: faceForId("writer"),
  });
  expect(profile.details).toMatchObject({
    task: "Draft the release notes every Friday.",
    machine: "Fake machine",
    routines: { items: [{ name: "Friday notes", failed: false }], more: 0 },
  });
  expect(profile.details.model).toMatch(/Sonnet/);
  const routines = profile.details.routines;
  expect("items" in routines && routines.items[0]?.line).toMatch(/^Weekdays at 9:00/);
  // A bot's Library has no About you: that is Spade's own.
  expect("about" in profile.library).toBe(false);
  expect(profile.library).toMatchObject({
    // A note compaction only suggested isn't the bot's until the person keeps it.
    notes: { items: ["Keep it under a page."], more: 0 },
    pages: { items: [{ title: "House style" }], more: 0 },
    // Spade's own bookkeeping folder isn't the bot's files.
    files: { items: [{ name: "draft.md", folder: false }], more: 0 },
    skills: { items: [{ name: "Release notes", word: "Wrote it" }], more: 0 },
  });
  expect(profile.computer).toEqual({
    line: "Asleep until it's needed",
    // Files counts as used once the bot has kept one.
    surfaces: [
      { name: "Terminal", line: "bun test", live: false },
      { name: "Files", line: null, live: false },
    ],
    services: { items: [{ name: "Preview", words: "Running", running: true }], more: 0 },
  });
});

test("a bot's chosen character face travels through the list and profile", async () => {
  const chosen = {
    body: "fox" as const,
    pair: "ember" as const,
    ears: "none" as const,
    marking: "mask" as const,
    eyes: "big" as const,
    mouth: "cat" as const,
    cheeks: "blush" as const,
    accessory: "scarf" as const,
  };
  const { ask, patches } = await setUp((fake) => {
    fake.addAgent({
      id: "scout",
      name: "Scout",
      avatar: { ...storedBotFace(chosen) },
    });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "scout") === true);

  const row = patches.state?.list.rows?.find((each) => each.id === "scout");
  expect(row?.faces).toEqual([{ main: false, initial: "S", away: false, character: chosen }]);

  const answer = await ask({ type: "spade.profile", agentId: "scout" });
  if (!("profile" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.profile.face).toEqual({
    main: false,
    initial: "S",
    away: false,
    character: chosen,
  });
});

test("Spade's own Library starts with what every bot knows about the person", async () => {
  const { ask, patches } = await setUp((fake) => {
    fake.addAgent({ id: "spade", name: "Spade", kind: "main" });
    fake.notes.add({ text: "Lives in Lisbon." });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.main) === true);

  const answer = await ask({ type: "spade.profile", agentId: "spade" });

  if (!("profile" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.profile.face).toEqual({ main: true, initial: "S", away: false, character: null });
  expect(answer.profile.library.about).toEqual({ items: ["Lives in Lisbon."], more: 0 });
  expect(answer.profile.computer.line).toBe("Spade hasn't used its computer yet");
});

test("a part Spade can't read says so while the rest of the profile shows", async () => {
  const { ask, api, daemon, patches } = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer", task: "Draft" });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  // Spade's skill store breaks; everything else answers as before.
  daemon.spade.serve({
    answer: (request) =>
      request.path === "/v1/skills" ? { status: 500, body: "{}" } : api.answer(request),
    open: (path) => api.open(path),
  });

  const answer = await ask({ type: "spade.profile", agentId: "writer" });

  if (!("profile" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.profile.library.skills).toEqual({ failed: true });
  expect(answer.profile.details.task).toBe("Draft");
  expect(answer.profile.library.notes).toEqual({ items: [], more: 0 });
});

test("About you that can't be read says so, apart from a bot that has none", async () => {
  const { ask, api, daemon, patches } = await setUp((fake) => {
    fake.addAgent({ id: "spade", name: "Spade", kind: "main" });
    fake.addAgent({ id: "writer", name: "Writer" });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  daemon.spade.serve({
    answer: (request) =>
      request.path === "/v1/notes" ? { status: 500, body: "{}" } : api.answer(request),
    open: (path) => api.open(path),
  });

  const spade = await ask({ type: "spade.profile", agentId: "spade" });
  const writer = await ask({ type: "spade.profile", agentId: "writer" });

  if (!("profile" in spade) || !("profile" in writer)) throw new Error("no profile");
  expect(spade.profile.library.about).toEqual({ failed: true });
  expect("about" in writer.profile.library).toBe(false);
});

test("the task the person rewrites shows on the very next profile, before the list reads again", async () => {
  const { ask, api, daemon, patches } = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer", task: "Draft" });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  // From the save on, the list's reads never come back: only the write can say what changed.
  let saved = false;
  daemon.spade.serve({
    answer: (request) => {
      if (saved && request.method === "GET" && request.path === "/v1/agents")
        return new Promise(() => {});
      if (request.method === "PATCH") saved = true;
      return api.answer(request);
    },
    open: (path) => api.open(path),
  });

  expect(await ask({ type: "spade.task", agentId: "writer", task: "  Draft and post  " })).toEqual({
    ok: true,
    task: "Draft and post",
  });

  expect(api.sent("PATCH", "/v1/agents/writer")).toEqual([{ task: "Draft and post" }]);
  const read = await ask({ type: "spade.profile", agentId: "writer" });
  if (!("profile" in read)) throw new Error(JSON.stringify(read));
  expect(read.profile.details.task).toBe("Draft and post");
});

test("a list read already out when the task is saved doesn't put the old task back", async () => {
  const { ask, api, daemon, patches, spade } = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer", task: "Draft" });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  // The next list read answers as Spade was before the save, but arrives only after it.
  let release: (() => void) | undefined;
  daemon.spade.serve({
    answer: (request) => {
      const answer = api.answer(request);
      if (release || request.method !== "GET" || request.path !== "/v1/agents") return answer;
      return new Promise((resolve) => {
        release = () => resolve(answer);
      });
    },
    open: (path) => api.open(path),
  });
  spade.handle({ type: "spade.refresh" });
  await until(() => release !== undefined);

  expect(await ask({ type: "spade.task", agentId: "writer", task: "Draft and post" })).toEqual({
    ok: true,
    task: "Draft and post",
  });
  release?.();
  // The stale read lands, and the read after it confirms the write.
  await until(() => api.requests.filter((each) => each.path === "/v1/agents").length >= 3);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const read = await ask({ type: "spade.profile", agentId: "writer" });
  if (!("profile" in read)) throw new Error(JSON.stringify(read));
  expect(read.profile.details.task).toBe("Draft and post");
});

test("saving the task leaves what the profile shows of the bot's computer as it was", async () => {
  const { ask, patches } = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer", task: "Draft" });
    fake.computer.use("writer", { kind: "browser", live: true, title: "Release notes", url: null });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);

  await ask({ type: "spade.task", agentId: "writer", task: "Draft and post" });

  const read = await ask({ type: "spade.profile", agentId: "writer" });
  if (!("profile" in read)) throw new Error(JSON.stringify(read));
  expect(read.profile.details.task).toBe("Draft and post");
  expect(read.profile.computer.surfaces).toEqual([
    { name: "Browser", line: "Release notes", live: true },
  ]);
});

/** A task save of `count` emoji: each one code point, two UTF-16 units. */
const emojiTask = (count: number) => ({
  type: "spade.task",
  agentId: "writer",
  task: "😀".repeat(count),
});

test("a task as long as Spade allows in code points is accepted, emoji and all", () => {
  const task = emojiTask;
  // 4,000 emoji are 8,000 UTF-16 units but 4,000 code points, which Spade allows.
  expect(NativeSpadeRequest.safeParse(task(4_000)).success).toBe(true);
  expect(NativeSpadeRequest.safeParse(task(4_001)).success).toBe(false);
});
