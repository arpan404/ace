import { faceForId, storedBotFace } from "@ace/ui-core/bot-face";
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
      { main: true, initial: "S", away: false, character: null },
      { main: false, initial: "R", away: false, character: faceForId("research") },
      { main: false, initial: "W", away: false, character: faceForId("writer") },
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
      face: { main: true, initial: "S", away: false, character: null },
      first: true,
      last: false,
    },
    {
      kind: "member",
      name: "Spade",
      text: "I'll ask Research.",
      face: { main: true, initial: "S", away: false, character: null },
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
      face: { main: false, initial: "R", away: false, character: faceForId("research") },
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

test("a waiting member's own chat stays one tap away while the bots can't be read again", async () => {
  const { patches, api, daemon, spade } = await setUp((fake) => team(fake));
  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === true);
  spade.handle({ type: "spade.open", conversationId: "c-launch", group: "launch" });
  await until(() => patches.head?.loaded === true);
  // From here Spade answers its groups but not its bots.
  let refused = 0;
  daemon.spade.serve({
    answer: (request) => {
      if (request.path !== "/v1/agents") return api.answer(request);
      refused++;
      return { status: 500, body: "{}" };
    },
    open: (path) => api.open(path),
  });
  const group = api.teams.groups[0];
  if (!group) throw new Error("no group");

  api.teams.status(group, "waiting", null, { id: "research", name: "Research", machine: null });
  spade.handle({ type: "spade.refresh" });

  await until(() => refused > 0 && patches.state?.list.failed === false);
  await until(() => patches.head?.waiting !== null && patches.head?.waiting !== undefined);
  expect(patches.head?.waiting).toEqual({ name: "Research", conversation: "c-research" });
});

test("group faces prefer the current roster avatar matched by machine and bot id, keeping remote saved avatars", async () => {
  const updated = faceForId("research-new-face");
  const remoteSaved = faceForId("studio-research-face");
  const { patches, api, spade } = await setUp((fake, daemon) => {
    const { research } = team(fake);
    // Replace the group with local Research (matching by hostId) and a remote Research on another machine.
    fake.teams.groups = [];
    const group = fake.teams.addGroup({
      id: "launch",
      name: "Launch team",
      members: [
        fake.teams.member("spade"),
        { ...fake.teams.member("research"), machine: daemon.hostId },
        {
          agent: "research",
          machine: "studio",
          name: "Studio Research",
          avatar: { ...storedBotFace(remoteSaved) },
          away: false,
        },
      ],
    });
    // Local Research changes its roster face after joining the group; the membership keeps the old avatar.
    research.avatar = { ...storedBotFace(updated) };
    fake.store(group.conversation, {
      type: "group_message",
      run: "r1",
      text: "Local note.",
      from: { id: "research", name: "Research", machine: null },
    });
    fake.store(group.conversation, {
      type: "group_message",
      run: "r1",
      text: "Remote note.",
      from: { id: "research", name: "Studio Research", machine: "studio" },
    });
    fake.store(group.conversation, {
      type: "group_asked",
      run: "r1",
      ask: "a1",
      by: { id: "spade", name: "Spade" },
      to: { id: "research", name: "Research", machine: null },
    });
  }, quick);

  const row = () => patches.state?.list.rows?.find((each) => each.group === "launch");
  await until(
    () =>
      row()?.faces[1]?.character?.body === updated.body &&
      row()?.faces[1]?.character?.pair === updated.pair,
  );
  expect(row()?.faces).toEqual([
    { main: true, initial: "S", away: false, character: null },
    { main: false, initial: "R", away: false, character: updated },
    { main: false, initial: "S", away: false, character: remoteSaved },
  ]);

  spade.handle({ type: "spade.open", conversationId: "c-launch", group: "launch" });
  await until(() => patches.bubbles.length === 3 && patches.head?.answering === true);
  expect(patches.bubbles).toMatchObject([
    {
      kind: "member",
      text: "Local note.",
      face: { main: false, initial: "R", away: false, character: updated },
    },
    {
      kind: "member",
      text: "Remote note.",
      face: { main: false, initial: "S", away: false, character: remoteSaved },
    },
    { kind: "note", text: "Spade asked Research" },
  ]);
  expect(patches.head?.working).toMatchObject({
    label: "Research is answering",
    moving: true,
    face: { main: false, initial: "R", away: false, character: updated },
  });
  expect(api.agents.find((agent) => agent.id === "research")?.avatar).toEqual(
    storedBotFace(updated),
  );
});

test("a group pinned from the phone is pinned in Spade, and its row says since when", async () => {
  const { api, patches, ask } = await setUp((fake) => team(fake));
  const row = () => patches.state?.list.rows?.find((each) => each.group === "launch");
  await until(() => row()?.pinnedAt === null);

  expect(await ask({ type: "spade.group.pin", groupId: "launch", pinned: true })).toEqual({
    ok: true,
  });

  const pinnedAt = api.teams.groups[0]?.pinned_at;
  expect(typeof pinnedAt).toBe("number");
  await until(() => row()?.pinnedAt === pinnedAt);
});

test("a group made on the phone has the members and lead it was given, and says its conversation", async () => {
  const { api, patches, ask } = await setUp((fake) => {
    fake.addAgent({ id: "spade", name: "Spade", kind: "main" });
    fake.addAgent({ id: "research", name: "Research" });
  });
  await until(() => (patches.state?.list.rows?.length ?? 0) === 2);

  const made = await ask({
    type: "spade.group.create",
    name: "Launch",
    members: [{ agent: "spade" }, { agent: "research" }, { agent: "writer", machine: "studio" }],
    lead: "research",
  });

  const group = api.teams.groups[0];
  expect(made).toEqual({ ok: true, group: group?.id, conversation: group?.conversation });
  expect(group?.name).toBe("Launch");
  expect(group?.lead.agent).toBe("research");
  expect(group?.members.map((member) => [member.agent, member.machine])).toEqual([
    ["spade", null],
    ["research", null],
    ["writer", "studio"],
  ]);
  // The new group lists at once, so its conversation opens with its row.
  await until(() => patches.state?.list.rows?.some((row) => row.group === group?.id) === true);
});

test("a group Spade refuses to make says why in its words", async () => {
  const { ask } = await setUp((fake) => {
    fake.addAgent({ id: "research", name: "Research" });
  });
  // With no Spade of its own to join, one member is too few.
  expect(
    await ask({
      type: "spade.group.create",
      name: "Solo",
      members: [{ agent: "research" }],
      lead: "research",
    }),
  ).toMatchObject({ ok: false, title: "Couldn't make the club", message: /2 to 32 members/ });
});

test("a group's profile reads its members with faces and its lead, and its edits reach Spade", async () => {
  const { api, patches, ask } = await setUp((fake) => {
    team(fake);
    fake.teams.groups[0]?.members.push({
      agent: "studio-notes",
      machine: "studio",
      name: "Studio Notes",
      avatar: null,
      away: true,
    });
  });
  // The profile opens from the group's row: the bots have been read by then.
  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === true);

  const read = await ask({ type: "spade.group.read", groupId: "launch" });
  expect(read).toMatchObject({
    ok: true,
    group: {
      id: "launch",
      name: "Launch team",
      conversation: "c-launch",
      lead: { agent: "spade", machine: null },
      members: [
        { agent: "spade", machine: null, name: "Spade", face: { main: true }, away: false },
        { agent: "research", machine: null, name: "Research", face: { initial: "R" } },
        { agent: "writer", machine: null, name: "Writer" },
        { agent: "notes", machine: null, name: "Notes" },
        { agent: "studio-notes", machine: "studio", name: "Studio Notes", away: true },
      ],
    },
  });

  expect(await ask({ type: "spade.group.edit", groupId: "launch", name: "Ship it" })).toEqual({
    ok: true,
  });
  expect(api.teams.groups[0]?.name).toBe("Ship it");

  expect(
    await ask({
      type: "spade.group.edit",
      groupId: "launch",
      members: [{ agent: "spade" }, { agent: "research" }],
      lead: "research",
    }),
  ).toEqual({ ok: true });
  expect(api.teams.groups[0]?.members.map((member) => member.agent)).toEqual(["spade", "research"]);
  expect(api.teams.groups[0]?.lead.agent).toBe("research");
});

test("a group Spade no longer has can't be read, and says so", async () => {
  const { ask } = await setUp();
  expect(await ask({ type: "spade.group.read", groupId: "gone" })).toMatchObject({
    ok: false,
    title: "Couldn't read the club",
  });
});

test("deleting a group removes it from Spade and from the list; its bots stay", async () => {
  const { api, patches, ask } = await setUp((fake) => team(fake));
  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === true);

  expect(await ask({ type: "spade.group.delete", groupId: "launch" })).toEqual({ ok: true });

  expect(api.teams.groups).toEqual([]);
  await until(() => patches.state?.list.rows?.some((row) => row.group === "launch") === false);
  expect(patches.state?.list.rows?.map((row) => row.name)).toContain("Research");
});

test("a group's Library lists the files its members made, newest first, with who made each", async () => {
  const { ask } = await setUp((fake) => {
    const { group } = team(fake);
    group.files = [
      { agent: "writer", path: "drafts/launch.md", at: 2_000 },
      { agent: "research", path: "notes.txt", at: 1_000 },
      { agent: "left", path: "old/plan.md", at: 500 },
    ];
  });

  expect(await ask({ type: "spade.group.files", groupId: "launch" })).toEqual({
    ok: true,
    files: [
      { agent: "writer", by: "Writer", name: "launch.md", path: "drafts/launch.md", at: 2_000 },
      { agent: "research", by: "Research", name: "notes.txt", path: "notes.txt", at: 1_000 },
      // A member who has left is named by its id, as Spade still keeps its file.
      { agent: "left", by: "left", name: "plan.md", path: "old/plan.md", at: 500 },
    ],
    more: 0,
  });
});
