import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";
import { spadeLibraryBudget } from "./spade-library.ts";
import { utf8Bytes } from "./spade-profile.ts";

/*
 * A bot's profile on the iPhone beyond its preview: the task's history with who made each
 * version, one search over its Library in web's groups, and its past work, against the fake Spade.
 */

async function withWriter(seed: Parameters<typeof setUp>[0] = () => {}) {
  const host = await setUp((fake, daemon) => {
    fake.addAgent({ id: "writer", name: "Writer", task: "Draft the notes." });
    seed(fake, daemon);
  });
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  return host;
}

test("a task edited elsewhere is a version the phone lists, newest first, with who made it", async () => {
  const { ask, api } = await withWriter();
  const bot = api.agents.find((agent) => agent.id === "writer");
  if (!bot) throw new Error("no bot");
  // As web edits it (PATCH /v1/agents/{id}), then as the bot rewrites its own.
  await ask({ type: "spade.task", agentId: "writer", task: "Draft and post the notes." });
  api.tasks.change(
    bot,
    "Draft, post and announce the notes.",
    "bot",
    "You asked me to announce them",
  );

  const answer = await ask({ type: "spade.task.history", agentId: "writer" });

  if (!("versions" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.versions.map(({ task, by, why }) => ({ task, by, why }))).toEqual([
    {
      task: "Draft, post and announce the notes.",
      by: "Changed by the bot",
      why: "You asked me to announce them",
    },
    { task: "Draft and post the notes.", by: "Changed by you", why: "" },
  ]);
  expect(answer.versions[0]?.at).toEqual(expect.any(Number));
});

test("a search returns web's groups in web's order, leaving out the ones with nothing", async () => {
  const { ask } = await withWriter((fake) => {
    fake.notes.add({ text: "Release notes go out on Fridays.", agent: "writer" });
    fake.notes.add({ text: "Keep it short.", agent: "writer" });
    fake.knowledge.add({
      agent: "writer",
      title: "Release checklist",
      body: "# Steps\n- Tag the **release**",
    });
    fake.knowledge.add({ agent: "writer", title: "House style", body: "Short lines." });
    fake.knowledge.addEpisode({
      agent: "writer",
      title: "Shipped the release notes",
      closed_at: 2,
    });
    fake.files.set("writer", {
      "release.md": "# Notes",
      "other.md": "",
      ".spade/state.json": "{}",
    });
    fake.skillStore = {
      ace: false,
      skills: [
        { id: "s1", name: "Release notes", origin: "spade", written_by: ["writer"] },
        { id: "s2", name: "Release radar", origin: "spade", written_by: ["someone-else"] },
      ],
    };
  });

  const answer = await ask({ type: "spade.library.search", agentId: "writer", query: "release" });

  if (!("found" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.failed).toBe(false);
  expect(answer.nothing).toBeNull();
  expect(answer.found.map((group) => [group.name, group.rows.map((row) => row.title)])).toEqual([
    ["Notes", ["Release notes go out on Fridays."]],
    ["Pages", ["Release checklist"]],
    ["Past work", ["Shipped the release notes"]],
    ["Files", ["release.md"]],
    // Only the bot's own skills: one it wrote or used.
    ["Skills", ["Release notes"]],
  ]);
  // A page's line is its body as plain words.
  expect(answer.found[1]?.rows[0]?.line).toBe("Steps Tag the release");
});

test("a search that matches nothing says so once", async () => {
  const { ask } = await withWriter((fake) => {
    fake.notes.add({ text: "Keep it short.", agent: "writer" });
  });

  const answer = await ask({ type: "spade.library.search", agentId: "writer", query: "zebra" });

  expect(answer).toMatchObject({
    ok: true,
    found: [],
    failed: false,
    nothing: "Nothing matches “zebra”.",
  });
});

test("past work lists newest closed first with what each came to, and one opens to read", async () => {
  const { ask } = await withWriter((fake) => {
    fake.knowledge.addEpisode({
      agent: "writer",
      title: "Drafted the notes",
      closed_at: 1_000,
      episode: { text: "Draft the notes" },
    });
    fake.knowledge.addEpisode({
      agent: "writer",
      title: "Posted the notes",
      outcome: "failed",
      closed_at: 3_000,
      cost_micros: 120_000,
      episode: {
        text: "Post them",
        note: "The blog was down.",
        criteria: [{ text: "Live on the blog", met: false }],
        failed: [{ text: "Publishing", why: "503 from the blog" }],
      },
    });
  });

  const past = await ask({ type: "spade.library.past", agentId: "writer" });

  if (!("episodes" in past)) throw new Error(JSON.stringify(past));
  expect(past.episodes.map(({ title, line }) => [title, line])).toEqual([
    ["Posted the notes", "The blog was down."],
    ["Drafted the notes", "Draft the notes"],
  ]);
  const opened = await ask({ type: "spade.library.episode", id: past.episodes[0]?.id ?? "" });
  expect(opened).toMatchObject({
    ok: true,
    episode: {
      title: "Posted the notes",
      outcome: "Ended as failed",
      criteria: [{ text: "Live on the blog", met: false }],
      failed: ["Publishing · 503 from the blog"],
      note: "The blog was down.",
    },
  });
});

test("a long history still fits one frame, the oldest versions counted as more", async () => {
  const { ask, api } = await withWriter();
  const bot = api.agents.find((agent) => agent.id === "writer");
  if (!bot) throw new Error("no bot");
  for (let at = 0; at < 30; at++) api.tasks.change(bot, `${at} ${"word ".repeat(400)}`, "person");

  const answer = await ask({ type: "spade.task.history", agentId: "writer" });

  if (!("versions" in answer)) throw new Error(JSON.stringify(answer));
  expect(utf8Bytes(JSON.stringify(answer))).toBeLessThanOrEqual(spadeLibraryBudget);
  expect(answer.versions[0]?.task.startsWith("29 ")).toBe(true);
  expect(answer.more).toBe(30 - answer.versions.length);
});
