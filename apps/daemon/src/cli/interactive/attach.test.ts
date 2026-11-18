import { Interaction } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { decodeKeys } from "../tui/keys.ts";
import { paint } from "../tui/paint.ts";
import { attachKey, attachStart, type AttachState } from "./attach-model.ts";
import { attachView } from "./attach-view.ts";
import type { Effect } from "./effects.ts";
import { threadReader } from "./reader.fixture.ts";
import type { OpenRequest } from "./request-answer.ts";
import { blockLines, unfoldedLines } from "./transcript.ts";
import { agentTree } from "./tree.ts";

const approval: OpenRequest = {
  interaction: Interaction.parse({
    id: "i1",
    threadId: "t1",
    agentId: "root",
    blocking: true,
    request: {
      kind: "approval",
      title: "bun test",
      target: { tool: "Bash", access: "execute", command: "bun run lint" },
      options: [
        { id: "once", label: "Yes", kind: "allow_once" },
        { id: "no", label: "No", kind: "deny" },
      ],
    },
    state: "pending",
    createdAt: 1,
  }),
  threadTitle: "Fix relay",
  project: "ace",
  provider: "claude",
};

function press(
  input: string,
  request?: OpenRequest,
  from: AttachState = attachStart,
  works: readonly string[] = [],
) {
  let state = from;
  const effects: Effect[] = [];
  for (const key of decodeKeys(input)) {
    const next = attachKey(state, request, key, 10, works);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

describe("attach keys", () => {
  it("sends the composer's text to the queue on Enter", () => {
    expect(press("run the tests\r").effects).toEqual([
      { kind: "send", text: "run the tests", delivery: "queue" },
    ]);
  });

  it("keeps the slash commands, and // sends text that starts with a slash", () => {
    expect(press("/steer smaller diff\r").effects).toEqual([
      { kind: "slash", line: "/steer smaller diff" },
    ]);
    expect(press("//etc/hosts is wrong\r").effects).toEqual([
      { kind: "send", text: "/etc/hosts is wrong", delivery: "queue" },
    ]);
  });

  it("answers an open request with y while the composer is empty", () => {
    const { effects } = press("y", approval);
    expect(effects).toEqual([
      expect.objectContaining({
        payload: {
          type: "interaction.resolve",
          interactionId: "i1",
          resolution: { kind: "approval", optionId: "once" },
        },
      }),
    ]);
  });

  it("types y into a composer that already holds text instead of answering", () => {
    const { state, effects } = press("ok y", approval);
    expect(effects).toEqual([]);
    expect(state.composer.text).toBe("ok y");
  });

  it("goes back to the home on Esc and opens the editor on Ctrl-G", () => {
    expect(press("\x1b").effects).toEqual([{ kind: "home" }]);
    expect(press("draft\x07").effects).toEqual([{ kind: "editor", text: "draft" }]);
  });
});

describe("unfolding a Worked for line", () => {
  const up = "\x1b[A";
  const down = "\x1b[B";
  const works = ["w1", "w2", "w3"];

  it("walks up from the newest work line and unfolds the one reached on Enter", () => {
    expect(press(`${up}\r`, undefined, attachStart, works).effects).toEqual([
      { kind: "unfold", key: "w3" },
    ]);
    expect(press(`${up}${up}${up}${up}\r`, undefined, attachStart, works).effects).toEqual([
      { kind: "unfold", key: "w1" },
    ]);
    expect(press(`${up}${up}${down}\r`, undefined, attachStart, works).effects).toEqual([
      { kind: "unfold", key: "w3" },
    ]);
  });

  it("leaves the work lines past the newest, on Esc, or when the person types", () => {
    const past = press(`${up}${down}`, undefined, attachStart, works).state;
    expect(past.focus).toBeUndefined();
    const escaped = press(`${up}\x1b`, undefined, attachStart, works);
    expect(escaped.state.focus).toBeUndefined();
    expect(escaped.effects).toEqual([]);
    const typed = press(`${up}hi`, undefined, attachStart, works);
    expect(typed.state.focus).toBeUndefined();
    expect(typed.state.composer.text).toBe("hi");
  });

  it("sends on Enter as before when nothing is focused, and leaves arrows to a typed prompt", () => {
    expect(press("go\r", undefined, attachStart, works).effects).toEqual([
      { kind: "send", text: "go", delivery: "queue" },
    ]);
    expect(press(`go${up}`, undefined, attachStart, works).state.focus).toBeUndefined();
    expect(press(`${up}\r`).effects).toEqual([]);
  });

  it("lets an open request answer first", () => {
    const { effects } = press("y", approval, attachStart, works);
    expect(effects).toEqual([expect.objectContaining({ kind: "command" })]);
  });

  it("draws the focused line with how to unfold it, and offers ↑ while work is there", () => {
    const view = {
      turn: [],
      request: undefined,
      requests: 0,
      live: undefined,
      fresh: false,
      connection: undefined,
    };
    const resting = attachView(attachStart, { ...view, work: true }, 80, 20, paint(false));
    expect(resting.lines.at(-1)).toContain("esc home · ↑ work · /steer");
    const focused = attachView(
      { ...attachStart, focus: "w1" },
      { ...view, work: true, focus: "▸ Worked for 2m 0s · Ran 1 command" },
      80,
      20,
      paint(false),
    ).lines.join("\n");
    expect(focused).toContain("› ▸ Worked for 2m 0s · Ran 1 command");
    expect(focused).toContain("↵ unfold its steps");
  });

  it("lists every step behind the line in order, with what the agent said and its answer", () => {
    const reader = threadReader({
      items: [
        {
          id: "s1",
          agentId: "root",
          createdAt: 2,
          complete: true,
          type: "tool_call",
          call: {
            id: "s1",
            agentId: "root",
            startedAt: 2,
            raw: [],
            kind: "shell",
            title: "Lint",
            status: "succeeded",
            detail: { kind: "shell", command: "bun run lint" },
          },
        },
        {
          id: "c1",
          agentId: "root",
          createdAt: 3,
          complete: true,
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "Lint is clean; now the tests." }],
        },
        {
          id: "s2",
          agentId: "root",
          createdAt: 4,
          complete: true,
          type: "tool_call",
          call: {
            id: "s2",
            agentId: "root",
            startedAt: 4,
            raw: [],
            kind: "shell",
            title: "Test",
            status: "failed",
            detail: { kind: "shell", command: "bun run test:fast" },
          },
        },
        {
          id: "a1",
          agentId: "root",
          createdAt: 5,
          complete: true,
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "One test fails." }],
        },
      ],
    });
    const lines = unfoldedLines(
      {
        kind: "work",
        key: "w",
        itemIds: [],
        until: 125_000,
        startedAt: 5_000,
        outcome: "completed",
        folded: [
          { kind: "work", key: "w1", itemIds: ["s1"] },
          { kind: "message", key: "m1", itemId: "c1" },
          { kind: "work", key: "w2", itemIds: ["s2"] },
        ],
        answerIds: ["a1"],
      },
      reader,
      125_000,
      80,
      paint(false),
    );
    expect(lines[0]).toMatch(/^▾ /);
    const lint = lines.findIndex((line) => line.includes("bun run lint"));
    const said = lines.findIndex((line) => line.includes("Lint is clean"));
    const test = lines.findIndex((line) => line.includes("bun run test:fast"));
    expect(lint).toBeGreaterThan(0);
    expect(said).toBeGreaterThan(lint);
    expect(test).toBeGreaterThan(said);
    expect(lines[test]).toContain("✕");
    expect(lines.at(-1)).toBe("One test fails.");
  });
});

describe("attach view", () => {
  it("puts the request strip, then the live line, then the composer at the foot", () => {
    const frame = attachView(
      attachStart,
      {
        turn: ["Fixing it."],
        request: approval,
        requests: 1,
        live: { text: "Working for 1m 4s · running tests", tone: "working" },
        fresh: false,
        connection: undefined,
      },
      80,
      20,
      paint(false),
    );
    const text = frame.lines.join("\n");
    const strip = text.indexOf("y Allow once");
    const live = text.indexOf("Working for 1m 4s");
    const composer = text.indexOf("› ");
    expect(strip).toBeGreaterThan(text.indexOf("Fixing it."));
    expect(live).toBeGreaterThan(strip);
    expect(composer).toBeGreaterThan(live);
    expect(frame.lines.at(-1)).toContain("esc home · /steer · /stop · /model");
    expect(frame.cursor?.row).toBe(frame.lines.length - 2);
  });

  it("keeps the foot and drops the oldest turn lines when the terminal is short", () => {
    const turn = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const frame = attachView(
      attachStart,
      {
        turn,
        request: undefined,
        requests: 0,
        live: undefined,
        fresh: false,
        connection: undefined,
      },
      80,
      10,
      paint(false),
    );
    expect(frame.lines.length).toBe(10);
    expect(frame.lines).toContain("line 39");
    expect(frame.lines).not.toContain("line 0");
  });
});

describe("transcript and agent tree", () => {
  it("shows a working subagent under a finished root as working", () => {
    const reader = threadReader({
      status: { state: "working", agents: 1 },
      agents: [
        { id: "root", status: { state: "idle" } },
        {
          id: "reviewer",
          status: { state: "working", activity: "tool", detail: "reading the diff" },
        },
      ],
    });
    const tree = agentTree(reader, 61_000);
    expect(tree.lines.map((line) => [line.name, line.tone])).toEqual([
      [expect.any(String), "idle"],
      ["reviewer", "working"],
    ]);
    expect(tree.lines[1]?.glyph).toBe("◌");
    expect(tree.lines[1]?.time).toBe("1m 0s");
  });

  it("wraps the agent's answer in full and sets the person's message to the right", () => {
    const reader = threadReader({
      items: [
        {
          id: "u1",
          agentId: "root",
          createdAt: 1,
          complete: true,
          type: "message",
          role: "user",
          parts: [{ type: "text", text: "Fix it" }],
        },
        {
          id: "m1",
          agentId: "root",
          createdAt: 2,
          complete: true,
          type: "message",
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "The close handler only reconnects after code 1006, so sleep never reconnects.",
            },
          ],
        },
      ],
    });
    const person = blockLines(
      { kind: "user", key: "u", itemId: "u1" },
      reader,
      0,
      40,
      paint(false),
    );
    expect(person).toEqual([`${" ".repeat(34)}Fix it`]);
    const answer = blockLines(
      { kind: "message", key: "m", itemId: "m1" },
      reader,
      0,
      40,
      paint(false),
    );
    expect(answer.length).toBeGreaterThan(1);
    expect(answer.join(" ")).toBe(
      "The close handler only reconnects after code 1006, so sleep never reconnects.",
    );
  });

  it("strips terminal control sequences from what an agent wrote", () => {
    const reader = threadReader({
      items: [
        {
          id: "m1",
          agentId: "root",
          createdAt: 2,
          complete: true,
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "ok\x1b[2J\x1b]0;title\x07 done" }],
        },
      ],
    });
    const lines = blockLines(
      { kind: "message", key: "m", itemId: "m1" },
      reader,
      0,
      40,
      paint(false),
    );
    expect(lines.join("")).not.toContain("\x1b");
  });
});
