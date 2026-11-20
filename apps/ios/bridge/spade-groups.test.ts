import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { quick, setUp } from "./spade-test-host.ts";

/*
 * Spade's groups on the iPhone (ADR 0132): a group's row among the bots, with its members'
 * faces, and its conversation, where each member speaks with its own face and name, a handoff
 * is one line, and the person posts to the group and stops it.
 */

/** Spade, Research and Writer, in a group Spade leads. */
function team(api: FakeSpadeApi) {
  const spade = api.addAgent({ id: "spade", name: "Spade", kind: "main", last_activity: 5_000 });
  const research = api.addAgent({ id: "research", name: "Research", last_activity: 4_000 });
  api.addAgent({ id: "writer", name: "Writer", last_activity: 3_000 });
  api.addAgent({ id: "notes", name: "Notes", last_activity: 9_000 });
  const group = api.teams.addGroup({
    id: "launch",
    name: "Launch team",
    members: ["spade", "research", "writer", "notes"].map((id) => api.teams.member(id)),
    last_activity: 1_000,
  });
  return { spade, research, group };
}

test("a group lists among the bots by its state, naming who spoke last, with three members' faces", async () => {
  const { patches, api } = await setUp((fake) => {
    const { group } = team(fake);
    group.last_message = {
      from: "agent",
      text: "The draft is in.",
      at: 1_000,
      agent: { id: "writer", name: "Writer", machine: null },
    };
    // `quick`: the list is read again at a hundredth of the phone's pace.
  }, quick);
  const row = () => patches.state?.list.rows?.find((each) => each.name === "Launch team");
  await until(() => row() !== undefined);

  expect(row()).toMatchObject({
    group: "launch",
    conversation: "c-launch",
    state: "rest",
    line: "Writer: The draft is in.",
    faces: [
      { main: true, initial: "S", away: false },
      { main: false, initial: "R", away: false },
      { main: false, initial: "W", away: false },
    ],
  });
  // Idle and oldest, it sits last.
  expect(patches.state?.list.rows?.at(-1)?.name).toBe("Launch team");

  const group = api.teams.groups[0];
  if (!group) throw new Error("no group");
  api.teams.status(group, "working", "Research is answering");
  await until(() => row()?.state === "working");
  // Working, it rises above the bots at rest, Spade still first.
  const names = patches.state?.list.rows?.map((each) => each.name);
  expect(names?.slice(0, 2)).toEqual(["Spade", "Launch team"]);
  expect(row()?.line).toBe("Research is answering");
});

test("a group's conversation shows each member with its face and name, and a handoff as one line", async () => {
  const { patches, spade } = await setUp((fake) => {
    const { group } = team(fake);
    fake.store(group.conversation, { type: "group_message", run: "r1", text: "Plan the launch" });
    fake.store(group.conversation, {
      type: "group_message",
      run: "r1",
      text: "On it.",
      from: { id: "spade", name: "Spade" },
    });
    fake.store(group.conversation, {
      type: "group_message",
      run: "r1",
      text: "I'll ask Research.",
      from: { id: "spade", name: "Spade" },
    });
    fake.store(group.conversation, {
      type: "group_asked",
      run: "r1",
      ask: "a1",
      by: { id: "spade", name: "Spade" },
      to: { id: "research", name: "Research" },
    });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === true);

  spade.handle({ type: "spade.open", conversationId: "c-launch", group: "launch" });

  await until(() => patches.bubbles.length === 4);
  expect(patches.bubbles).toEqual([
    { kind: "person", text: "Plan the launch", sending: false, attached: null },
    {
      kind: "member",
      name: "Spade",
      text: "On it.",
      face: { main: true, initial: "S", away: false },
      first: true,
      last: false,
    },
    {
      kind: "member",
      name: "Spade",
      text: "I'll ask Research.",
      face: { main: true, initial: "S", away: false },
      first: false,
      last: true,
    },
    { kind: "note", text: "Spade asked Research" },
  ]);
  // The open ask names who answers, with that member's face beside the line.
  await until(() => patches.head?.answering === true);
  expect(patches.head).toMatchObject({
    group: "launch",
    working: {
      label: "Research is answering",
      moving: true,
      face: { main: false, initial: "R", away: false },
    },
    waiting: null,
  });
});

test("a member waiting on the person says so, and names the chat that holds the question", async () => {
  const { patches, api, spade } = await setUp((fake) => team(fake));
  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === true);
  spade.handle({ type: "spade.open", conversationId: "c-launch", group: "launch" });
  await until(() => patches.head?.loaded === true);
  const group = api.teams.groups[0];
  if (!group) throw new Error("no group");

  api.teams.status(group, "waiting", null, { id: "research", name: "Research", machine: null });

  await until(() => patches.head?.waiting !== null && patches.head?.waiting !== undefined);
  expect(patches.head).toMatchObject({
    working: { label: "Research is waiting for you", moving: false },
    waiting: { name: "Research", conversation: "c-research" },
  });
});

test("the person posts to the group, which shows at once, and Stop ends its run", async () => {
  const { patches, api, spade, ask } = await setUp((fake) => team(fake));
  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === true);
  spade.handle({ type: "spade.open", conversationId: "c-launch", group: "launch" });
  await until(() => patches.head?.loaded === true);

  const sent = await ask({
    type: "spade.group.send",
    groupId: "launch",
    conversationId: "c-launch",
    text: "Ship it Friday",
  });

  expect(sent).toEqual({ ok: true });
  expect(api.sent("POST", "/v1/groups/launch/messages")).toEqual([{ text: "Ship it Friday" }]);
  await until(() => patches.bubbles.some((row) => row.kind === "person" && !row.sending));
  expect(patches.bubbles).toEqual([
    { kind: "person", text: "Ship it Friday", sending: false, attached: null },
  ]);

  expect(await ask({ type: "spade.group.stop", groupId: "launch" })).toEqual({ ok: true });
  await until(() => patches.bubbles.some((row) => row.kind === "note"));
  expect(patches.bubbles.at(-1)).toEqual({ kind: "note", text: "Stopped" });
});

test("a group Spade refuses a message from gives the words back with why", async () => {
  const { patches, spade, ask } = await setUp((fake) => team(fake));
  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === true);
  spade.handle({ type: "spade.open", conversationId: "c-launch", group: "launch" });
  await until(() => patches.head?.loaded === true);

  const sent = await ask({
    type: "spade.group.send",
    groupId: "gone",
    conversationId: "c-launch",
    text: "Hello?",
  });

  expect(sent).toMatchObject({ ok: false, title: "Couldn't send" });
  expect(patches.bubbles).toEqual([]);
});

test("a group waiting on the person stays in the list while the bots can't be read", async () => {
  const { patches } = await setUp((fake, daemon) => {
    team(fake);
    const group = fake.teams.groups[0];
    if (!group) throw new Error("no group");
    group.state = "waiting";
    group.status = "Research is waiting for you";
    // Spade answers its groups, but not its bots.
    daemon.spade.serve({
      answer: (request) =>
        request.path === "/v1/agents" ? { status: 500, body: "{}" } : fake.answer(request),
      open: (path) => fake.open(path),
    });
  });

  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === true);
  expect(patches.state?.list).toMatchObject({
    rows: [{ group: "launch", state: "needs-you", line: "Research is waiting for you" }],
    failed: true,
  });
});
