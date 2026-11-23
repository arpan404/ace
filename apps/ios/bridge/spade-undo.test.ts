import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";
import type { SpadeBubbleRow } from "./spade-rows.ts";

/*
 * Undo in a bot's conversation on the iPhone (ADR 0167): a reply that changed the bot's files
 * says so in one quiet line that undoes the whole reply or one change; a confirm first says what
 * goes back and what can't, and a refusal says why.
 */

type Call = { id: string; name: string; arguments: object; effect?: string };

/** Travel wrote a file and sent an email in one reply; the write's `tool_started` is event 4. */
function travel(api: FakeSpadeApi, calls: Call[]) {
  const bot = api.addAgent({ id: "travel", name: "Travel" });
  const c = bot.conversation;
  api.store(c, { type: "user_message", text: "Draft the plan and send it" });
  api.store(c, { type: "reply_started", reply: "r1" });
  api.store(c, {
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
  });
  for (const call of calls) {
    api.store(c, {
      type: "tool_started",
      reply: "r1",
      call_id: call.id,
      name: call.name,
      ...(call.effect ? { effect: call.effect } : {}),
    });
    api.store(c, {
      type: "tool_finished",
      reply: "r1",
      call_id: call.id,
      name: call.name,
      content: "ok",
      is_error: false,
    });
  }
  api.store(c, { type: "step_finished", reply: "r1", text: "Done." });
  api.store(c, { type: "reply_finished", reply: "r1", text: "Done.", cost_micros: 0 });
  return bot;
}

const writeAndSend: Call[] = [
  { id: "c1", name: "workspace_write", arguments: { path: "plan.md", content: "x" } },
  { id: "c2", name: "workspace_write", arguments: { path: "notes.md", content: "y" } },
  { id: "c3", name: "send_email", arguments: { subject: "The plan" }, effect: "send_as_person" },
];

const changes = (bubbles: SpadeBubbleRow[]) => bubbles.find((row) => row.kind === "changes");

async function opened(calls: Call[]) {
  const host = await setUp((fake) => void travel(fake, calls));
  host.spade.handle({ type: "spade.open", conversationId: "c-travel" });
  await until(() => changes(host.patches.bubbles) !== undefined);
  return host;
}

test("a reply that changed its files says so under it, offering to undo the reply or one change", async () => {
  const { patches } = await opened(writeAndSend);

  expect(changes(patches.bubbles)).toEqual({
    kind: "changes",
    text: "Wrote 2 files, sent an email",
    undo: { from: 4, stays: ["Sent an email"] },
    steps: [
      { from: 4, line: "Wrote a file", detail: "plan.md" },
      { from: 6, line: "Wrote a file", detail: "notes.md" },
    ],
  });
  // Its words stay their own bubble, above the line.
  expect(patches.bubbles.findIndex((row) => row.kind === "bot")).toBeLessThan(
    patches.bubbles.findIndex((row) => row.kind === "changes"),
  );
});

test("a reply that changed nothing undo can reach shows no undo line", async () => {
  const host = await setUp((fake) => void travel(fake, [writeAndSend[2] as Call]));
  host.spade.handle({ type: "spade.open", conversationId: "c-travel" });
  await until(() => host.patches.bubbles.some((row) => row.kind === "bot"));
  expect(changes(host.patches.bubbles)).toBeUndefined();
});

test("undo first says what goes back, then puts the checkpoint back and the bot is told", async () => {
  const { api, ask } = await opened(writeAndSend);
  const at = Date.UTC(2026, 10, 22, 9, 30);
  api.security.checkpoints.set("travel", [{ id: "cp_before", at, reason: "auto" }]);
  api.security.undoPreviews.set(
    "travel",
    new Map([
      [
        4,
        {
          checkpoint: { id: "cp_before", at },
          changes: { changed: ["plan.md"], added: ["notes.md"], deleted: [], more: 0 },
        },
      ],
    ]),
  );

  const preview = await ask({
    type: "spade.undo.preview",
    agentId: "travel",
    seq: 4,
    timeZone: "UTC",
  });
  expect(preview).toMatchObject({
    ok: true,
    undo: {
      checkpoint: "cp_before",
      changed: ["plan.md"],
      added: ["notes.md"],
      deleted: [],
      more: 0,
      empty: false,
    },
  });
  if (!("undo" in preview)) throw new Error("no preview");
  expect(preview.undo.sentence).toMatch(
    /^Travel's files go back to how they were at .*9:30.*: 1 file goes back and 1 new file is removed\. Anything changed after that goes back too\.$/,
  );
  // Nothing changed yet.
  expect(api.security.restored.get("travel")).toBeUndefined();

  expect(await ask({ type: "spade.undo", agentId: "travel", checkpoint: "cp_before" })).toEqual({
    ok: true,
    message: "Undone. Travel knows its files went back.",
  });
  expect(api.security.restored.get("travel")).toEqual(["cp_before"]);
});

test("an undo Spade refuses says why: the bot is working, or there's no checkpoint any more", async () => {
  const { api, ask } = await opened(writeAndSend);
  api.security.checkpoints.set("travel", [{ id: "cp_before", at: 1, reason: "auto" }]);

  // No preview kept for this step: Spade has no checkpoint from before it.
  expect(await ask({ type: "spade.undo.preview", agentId: "travel", seq: 6 })).toEqual({
    ok: false,
    title: "Couldn't undo",
    message: "There's no checkpoint from before this anymore, so it can't be undone.",
  });

  const bot = api.agents.find((agent) => agent.id === "travel");
  if (bot) bot.state = "working";
  expect(await ask({ type: "spade.undo", agentId: "travel", checkpoint: "cp_before" })).toEqual({
    ok: false,
    title: "Couldn't undo",
    message: "Travel is working. Stop it first, then undo.",
  });
});
