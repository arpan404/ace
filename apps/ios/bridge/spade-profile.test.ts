import { expect, test } from "vitest";
import { until } from "./test-host.ts";
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
  expect(profile.face).toEqual({ main: false, initial: "W", away: false });
  expect(profile.details).toMatchObject({
    task: "Draft the release notes every Friday.",
    machine: "Fake machine",
    routines: [{ name: "Friday notes", failed: false }],
  });
  expect(profile.details.model).toMatch(/Sonnet/);
  expect(profile.details.routines?.[0]?.line).toMatch(/^Weekdays at 9:00/);
  expect(profile.library).toMatchObject({
    about: null,
    // A note compaction only suggested isn't the bot's until the person keeps it.
    notes: ["Keep it under a page."],
    pages: [{ title: "House style" }],
    // Spade's own bookkeeping folder isn't the bot's files.
    files: [{ name: "draft.md", folder: false }],
    skills: [{ name: "Release notes", word: "Wrote it" }],
  });
  expect(profile.computer).toEqual({
    line: "Asleep until it's needed",
    // Files counts as used once the bot has kept one.
    surfaces: [
      { name: "Terminal", line: "bun test", live: false },
      { name: "Files", line: null, live: false },
    ],
    services: [{ name: "Preview", words: "Running", running: true }],
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
  expect(answer.profile.face.main).toBe(true);
  expect(answer.profile.library.about).toEqual(["Lives in Lisbon."]);
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
  expect(answer.profile.library.skills).toBeNull();
  expect(answer.profile.details.task).toBe("Draft");
  expect(answer.profile.library.notes).toEqual([]);
});

test("the task the person rewrites is saved, and the list reads it back", async () => {
  const { ask, api, patches } = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer", task: "Draft" });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);

  expect(await ask({ type: "spade.task", agentId: "writer", task: "  Draft and post  " })).toEqual({
    ok: true,
  });

  expect(api.sent("PATCH", "/v1/agents/writer")).toEqual([{ task: "Draft and post" }]);
  // The list is read again once it saved, so the profile opened next shows the new task.
  await until(() => api.agents.find((agent) => agent.id === "writer")?.task === "Draft and post");
  let task: string | undefined;
  for (let attempt = 0; attempt < 50 && task !== "Draft and post"; attempt++) {
    const read = await ask({ type: "spade.profile", agentId: "writer" });
    task = "profile" in read ? read.profile.details.task : undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(task).toBe("Draft and post");
});
