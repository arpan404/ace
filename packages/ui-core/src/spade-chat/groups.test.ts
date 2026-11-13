import { faceForId, storedBotFace } from "../bot-face/index.ts";
import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  emptySpadeGroup,
  foldSpade,
  foldSpadeGroup,
  parseSpadeGroups,
  parseSpadeImport,
  parseSpadeLiveFrame,
  parseSpadeTemplates,
  spadeBotFileName,
  spadeBubbles,
  spadeGroupLine,
  spadeGroupView,
  spadeGroupWaiting,
  spadeView,
  type SpadeGroupRow,
} from "./index.ts";

const spade = { id: "main", name: "Spade", machine: null };
const research = { id: "research", name: "Research", machine: null };
const studio = { id: "writer", name: "Writer", machine: "studio-host" };

function group() {
  const state = emptySpadeGroup();
  let seq = 0;
  const frame = (event: string, data: unknown) => {
    const input = parseSpadeLiveFrame(event, JSON.stringify(data));
    if (input) foldSpadeGroup(state, input);
  };
  const stored = (event: Record<string, unknown>) =>
    frame("stored", { seq: ++seq, at: seq, event });
  const view = () => spadeGroupView(state);
  return { state, frame, stored, view, rows: () => view().rows.map(said) };
}

const said = (row: SpadeGroupRow) =>
  row.kind === "person"
    ? `person: ${row.text}${row.sending ? " (sending)" : ""}`
    : row.kind === "line"
      ? `line: ${row.text}`
      : `${row.bot.name}${row.first ? " [name]" : ""}${row.last ? " [face]" : ""}: ${row.text}`;

describe("a group's chat", () => {
  test("shows the person, each member's answers with name and face once per run, and handoffs as lines", () => {
    const g = group();
    g.stored({ type: "group_message", run: "u1", text: "Find flights", from: null });
    g.stored({ type: "group_asked", run: "u1", ask: "a1", by: null, to: spade, depth: 1 });
    g.stored({ type: "group_asked", run: "u1", ask: "a2", by: spade, to: research, depth: 2 });
    g.stored({ type: "group_answered", run: "u1", ask: "a2", to: research, outcome: "answered" });
    g.stored({ type: "group_message", run: "u1", text: "Three options", from: research });
    g.stored({ type: "group_message", run: "u1", text: "The cheapest is Tuesday", from: research });
    g.stored({ type: "group_message", run: "u1", text: "Booking Tuesday?", from: spade });
    g.stored({ type: "group_answered", run: "u1", ask: "a1", to: spade, outcome: "answered" });
    expect(g.rows()).toEqual([
      "person: Find flights",
      "line: Spade asked Research",
      "Research [name]: Three options",
      "Research [face]: The cheapest is Tuesday",
      "Spade [name] [face]: Booking Tuesday?",
    ]);
    expect(g.view().busy).toBe(false);
  });

  test("tool calls and a bot conversation's own events never show", () => {
    const g = group();
    g.stored({ type: "reply_started", reply: "r1" });
    g.stored({ type: "tool_started", reply: "r1", call_id: "c1", name: "shell" });
    g.stored({ type: "group_message", run: "u1", text: "Done", from: spade });
    expect(g.rows()).toEqual(["Spade [name] [face]: Done"]);
  });

  test("a queued ask, a failed one and Stop each read as one short line", () => {
    const g = group();
    g.stored({ type: "group_asked", run: "u1", ask: "a1", by: spade, to: studio, depth: 2 });
    g.stored({ type: "group_queued", run: "u1", ask: "a1", to: studio, machine_name: "Studio" });
    g.stored({ type: "group_asked", run: "u1", ask: "a2", by: spade, to: research, depth: 2 });
    g.stored({
      type: "group_answered",
      run: "u1",
      ask: "a2",
      to: research,
      outcome: "failed",
      detail: "the model refused",
    });
    expect(g.view().working).toEqual(studio);
    g.stored({ type: "group_answered", run: "u1", ask: "a1", to: studio, outcome: "stopped" });
    g.stored({ type: "group_stopped", run: "u1" });
    expect(g.rows()).toEqual([
      "line: Spade asked Writer",
      "line: Waiting for Studio to come online",
      "line: Spade asked Research",
      "line: Research couldn't answer: the model refused",
      "line: Stopped",
    ]);
    expect(g.view().working).toBeUndefined();
  });

  test("the person's message shows at once and once Spade stores it, only once", () => {
    const g = group();
    foldSpadeGroup(g.state, { kind: "sent", key: "local-1", text: "Hi all" });
    expect(g.rows()).toEqual(["person: Hi all (sending)"]);
    g.stored({ type: "group_message", run: "u1", text: "Hi all", from: null });
    expect(g.rows()).toEqual(["person: Hi all"]);
  });

  test("status frames say what the group does; the member answering is the open ask's", () => {
    const g = group();
    g.stored({ type: "group_asked", run: "u1", ask: "a1", by: null, to: research, depth: 1 });
    g.frame("status", { state: "waiting", status: "Research is waiting for you" });
    expect(g.view()).toMatchObject({
      busy: true,
      state: "waiting",
      status: "Research is waiting for you",
      working: research,
    });
    g.stored({ type: "group_answered", run: "u1", ask: "a1", to: research, outcome: "answered" });
    g.frame("status", { state: "idle", status: null });
    expect(g.view()).toMatchObject({ busy: false, status: undefined, working: undefined });
  });

  test("the member waiting for the person is the one the server names, not the latest open ask", () => {
    const g = group();
    g.stored({ type: "group_asked", run: "u1", ask: "a1", by: null, to: spade, depth: 1 });
    g.stored({ type: "group_asked", run: "u1", ask: "a2", by: spade, to: research, depth: 2 });
    g.stored({ type: "group_asked", run: "u1", ask: "a3", by: spade, to: studio, depth: 2 });
    g.frame("status", { state: "working", status: "Research is answering" });
    expect(spadeGroupWaiting(g.view(), [])).toBeUndefined();
    g.frame("status", {
      state: "waiting",
      status: "Research is waiting for you",
      waiting_member: { id: "research", name: "Research", machine: null },
    });
    expect(g.view().working).toEqual(studio);
    expect(spadeGroupWaiting(g.view(), [spade, research, studio])).toEqual(research);
  });

  test("the waiting member is found by id and machine, whatever the status words say", () => {
    const g = group();
    g.stored({ type: "group_asked", run: "u1", ask: "a1", by: null, to: spade, depth: 1 });
    // Words in another language, or a renamed bot: only the id counts.
    g.frame("status", {
      state: "waiting",
      status: "Writer wartet auf dich",
      waiting_member: { id: "writer", name: "Old name", machine: "studio-host" },
    });
    expect(spadeGroupWaiting(g.view(), [spade, research, studio])).toEqual(studio);
    // Words alone name no one.
    g.frame("status", { state: "waiting", status: "Research is waiting for you" });
    expect(spadeGroupWaiting(g.view(), [spade, research, studio])).toBeUndefined();
    g.frame("status", { state: "idle", status: null });
    expect(g.view().waitingMember).toBeUndefined();
  });

  test("an event seen twice after a reconnect shows once", () => {
    const g = group();
    g.stored({ type: "group_message", run: "u1", text: "Hi", from: spade });
    g.frame("stored", {
      seq: 1,
      at: 1,
      event: { type: "group_message", run: "u1", text: "Hi", from: spade },
    });
    expect(g.rows()).toEqual(["Spade [name] [face]: Hi"]);
  });
});

test("in a bot's own chat a group's message reads as a label, not as the person", () => {
  const state = emptySpadeConversation();
  const input = parseSpadeLiveFrame(
    "stored",
    JSON.stringify({
      seq: 1,
      at: 1,
      event: {
        type: "user_message",
        text: "Find flights",
        from_group: { id: "g1", name: "Trips", run: "u1", ask: "a1", untrusted: false },
      },
    }),
  );
  if (input) foldSpade(state, input);
  expect(spadeBubbles(spadeView(state))).toEqual([
    { kind: "group", key: "s1", group: "Trips", text: "Find flights", agent: undefined },
  ]);
});

describe("groups as Spade lists them", () => {
  const body = JSON.stringify({
    groups: [
      {
        id: "g1",
        name: "Trips",
        lead: {
          agent: "main",
          machine: null,
          name: "Spade",
          avatar: { kind: "spade" },
          away: false,
        },
        members: [
          { agent: "main", machine: null, name: "Spade", avatar: { kind: "spade" }, away: false },
          { agent: "writer", machine: "studio-host", name: "Writer", avatar: null, away: true },
        ],
        conversation: "c-g1",
        last_activity: 5,
        state: "idle",
        status: null,
        last_message: {
          from: "agent",
          text: "Three options",
          at: 5,
          agent: { id: "research", name: "Research", machine: null },
        },
      },
      { id: "broken" },
    ],
  });

  test("a group without a conversation is left out; members keep their faces and away", () => {
    const groups = parseSpadeGroups(body) ?? [];
    expect(groups.map((each) => each.id)).toEqual(["g1"]);
    expect(groups[0]?.members).toEqual([
      { agent: "main", machine: null, name: "Spade", avatar: { kind: "spade" }, away: false },
      {
        agent: "writer",
        machine: "studio-host",
        name: "Writer",
        avatar: {
          kind: "character",
          face: faceForId("writer"),
          raw: storedBotFace(faceForId("writer")),
        },
        away: true,
      },
    ]);
  });

  test("a group's row reads its last message with who said it, or its status while busy", () => {
    const [trips] = parseSpadeGroups(body) ?? [];
    if (!trips) throw new Error("no group");
    expect(spadeGroupLine(trips)).toEqual({ text: "Research: Three options" });
    expect(spadeGroupLine({ ...trips, state: "working", status: "Research is answering" })).toEqual(
      { text: "Research is answering", tone: "working" },
    );
  });
});

test("templates read with their face, one without a readable face gets the one its id seeds", () => {
  const owl = { kind: "character", v: 1, body: "bird", pair: "sky" };
  const read = parseSpadeTemplates(
    JSON.stringify({
      templates: [
        { id: "digest", name: "Digest", blurb: "Mornings", task: "Read", face: owl },
        { id: "odd", name: "Odd", blurb: "", task: "", color: "chartreuse" },
      ],
    }),
  );
  expect(read?.[0]?.face).toMatchObject({ body: "bird", pair: "sky" });
  expect(read?.[1]?.face).toEqual(faceForId("odd"));
});

test("an import's answer keeps each line the machine left out", () => {
  const answer = parseSpadeImport(
    JSON.stringify({
      agent: { id: "b1", name: "Research", conversation: "c-b1" },
      left_out: ["The model openrouter/x isn't here; it uses the default model."],
    }),
  );
  expect(answer?.agent.id).toBe("b1");
  expect(answer?.leftOut).toEqual([
    "The model openrouter/x isn't here; it uses the default model.",
  ]);
});

test("an exported bot's file name is safe to save anywhere", () => {
  expect(spadeBotFileName("Research")).toBe("Research.spade-bot.json");
  expect(spadeBotFileName("a/b: c?")).toBe("a b c.spade-bot.json");
  expect(spadeBotFileName("...")).toBe("bot.spade-bot.json");
});
