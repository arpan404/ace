import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";
import type { SpadeProfilePermissions } from "./spade-profile-permissions.ts";
import type { SpadeProfileWork } from "./spade-profile-work.ts";

/*
 * A bot's Permissions and Work tabs on the iPhone, over the real SDK, a fake daemon and a fake
 * Spade: the switches over the default, one changed for that bot alone, and the goal, evidence,
 * workers and decisions a bot mid-task shows.
 */

function partOf<T>(answer: unknown): T {
  if (typeof answer !== "object" || answer === null || !("part" in answer))
    throw new Error(JSON.stringify(answer));
  return answer.part as T;
}

test("a bot's Permissions say which switches follow the default, and a change reaches only that bot", async () => {
  const { ask, patches } = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.addAgent({ id: "scout", name: "Scout" });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "scout") === true);

  const before = partOf<SpadeProfilePermissions>(
    await ask({ type: "spade.permissions", agentId: "writer" }),
  );
  const browser = before?.rows.find((row) => row.key === "browser");
  expect(browser).toMatchObject({ title: "Browser", own: false });
  expect(before?.rows.map((row) => row.key)).toContain("computer_use");

  const after = partOf<SpadeProfilePermissions>(
    await ask({ type: "spade.permission", agentId: "writer", key: "browser", on: !browser?.on }),
  );
  expect(after?.rows.find((row) => row.key === "browser")).toMatchObject({
    on: !browser?.on,
    own: true,
  });
  // Only the bot it was changed on: the other still follows the default.
  const other = partOf<SpadeProfilePermissions>(
    await ask({ type: "spade.permissions", agentId: "scout" }),
  );
  expect(other?.rows.find((row) => row.key === "browser")).toMatchObject({
    on: browser?.on,
    own: false,
  });

  // Back to the default.
  const reset = partOf<SpadeProfilePermissions>(
    await ask({ type: "spade.permission", agentId: "writer", key: "browser", on: null }),
  );
  expect(reset?.rows.find((row) => row.key === "browser")).toMatchObject({
    on: browser?.on,
    own: false,
  });
});

test("turning a permission on without the person's standing is refused in words, and nothing changes", async () => {
  const { ask, api, patches } = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.security.permissions.standing = false;
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  const before = partOf<SpadeProfilePermissions>(
    await ask({ type: "spade.permissions", agentId: "writer" }),
  );
  const off = before?.rows.find((row) => !row.on);
  if (!off) throw new Error("every switch is on");

  const answer = await ask({ type: "spade.permission", agentId: "writer", key: off.key, on: true });

  expect(answer).toMatchObject({
    ok: false,
    title: "Couldn't change the permission",
    confirmPerson: true,
  });
  const now = partOf<SpadeProfilePermissions>(
    await ask({ type: "spade.permissions", agentId: "writer" }),
  );
  expect(now?.rows.find((row) => row.key === off.key)).toMatchObject({ on: false, own: false });

  const retry = {
    type: "spade.permission" as const,
    agentId: "writer",
    key: off.key,
    on: true,
    confirmed: true,
  };
  expect(await ask(retry)).toMatchObject({ ok: false, confirmPerson: false });
  api.security.permissions.standing = true;
  const saved = partOf<SpadeProfilePermissions>(await ask(retry));
  expect(saved?.rows.find((row) => row.key === off.key)).toMatchObject({ on: true, own: true });
});

test("Work shows a bot's goal with its evidence, its workers and what it decided for the person", async () => {
  let conversation = "";
  const host = await setUp((fake) => {
    const bot = fake.addAgent({ id: "release", name: "Release", state: "working" });
    conversation = bot.conversation;
    fake.addAgent({ id: "notes", name: "Notes", parent: { id: "release", name: "Release" } });
    fake.work.setTask("release", {
      goal: {
        id: "g1",
        title: "Ship 2.0",
        text: "get 2.0 out",
        criteria: [{ id: "1", text: "CI is green" }],
        by: "person",
      },
      items: [
        {
          id: "i1",
          text: "Run the checks",
          status: "done",
          verified: true,
          evidence: [
            { kind: "output", call: "call-ci" },
            { kind: "url", url: "https://example.com/run/1" },
          ],
        },
        { id: "i2", text: "Tag the release", status: "blocked", reason: "Needs your approval" },
      ],
      verdict: null,
    });
    fake.store(conversation, { type: "user_message", text: "Ship it" });
    fake.store(conversation, { type: "reply_started", reply: "r1" });
    fake.store(conversation, {
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "call-ci", name: "shell", arguments: { command: "gh pr checks 2081" } }],
    });
    fake.store(conversation, {
      type: "decision_made",
      decision: "d1",
      call_id: "call-d",
      choice: "Tag it 2.0.0, not 2.0",
      reason: "The other tags have three parts.",
      options: ["2.0"],
    });
  });
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === "release") === true);
  host.spade.handle({ type: "spade.open", conversationId: conversation });
  await until(() => host.spade.follow(conversation)?.get().view.decisions.length === 1);

  const work = partOf<SpadeProfileWork>(await host.ask({ type: "spade.work", agentId: "release" }));

  expect(work.goal).toMatchObject({
    title: "Ship 2.0",
    criteria: [{ text: "CI is green" }],
    plan: [
      {
        text: "Run the checks",
        mark: "verified",
        evidence: [
          { kind: "output", words: "gh pr checks 2081" },
          { kind: "url", words: "example.com/run/1", at: null },
        ],
      },
      { text: "Tag the release", mark: "waiting", note: { text: "Needs your approval" } },
    ],
  });
  // Where in the conversation the output came from: the reply that ran it.
  expect(work.goal?.plan[0]?.evidence[0]?.at).toEqual(expect.any(Number));
  expect(work.workers).toMatchObject([{ id: "notes", name: "Notes", kind: "bot" }]);
  expect(work.decisions).toMatchObject([
    {
      choice: "Tag it 2.0.0, not 2.0",
      reason: "The other tags have three parts.",
      quote: "> Tag it 2.0.0, not 2.0",
    },
  ]);
  expect(work.moving).toBe(true);
});

test("Work follows a bot as its plan moves on", async () => {
  const host = await setUp((fake) => {
    fake.addAgent({ id: "release", name: "Release" });
    fake.work.setTask("release", {
      goal: { id: "g1", title: "Ship 2.0", text: "", criteria: [{ id: "1", text: "Out" }] },
      items: [{ id: "i1", text: "Run the checks", status: "working" }],
      verdict: null,
    });
  });
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === "release") === true);
  const first = partOf<SpadeProfileWork>(
    await host.ask({ type: "spade.work", agentId: "release" }),
  );
  expect(first.goal?.plan[0]?.mark).toBe("working");

  host.api.work.setTask("release", {
    goal: { id: "g1", title: "Ship 2.0", text: "", criteria: [{ id: "1", text: "Out" }] },
    items: [{ id: "i1", text: "Run the checks", status: "done", verified: true }],
    verdict: null,
  });

  const next = partOf<SpadeProfileWork>(await host.ask({ type: "spade.work", agentId: "release" }));
  expect(next.goal?.plan[0]?.mark).toBe("verified");
  // Without its conversation open there are no decisions to show, and nothing breaks.
  expect(next.decisions).toEqual([]);
});
