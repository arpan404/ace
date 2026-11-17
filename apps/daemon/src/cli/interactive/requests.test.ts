import { Interaction } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { decodeKeys } from "../tui/keys.ts";
import { paint } from "../tui/paint.ts";
import type { Effect } from "./effects.ts";
import type { OpenRequest } from "./request-answer.ts";
import { requestsKey, requestsStart, requestsView, type RequestsState } from "./requests.ts";

function request(id: string, ask: unknown, thread = "t1"): OpenRequest {
  return {
    interaction: Interaction.parse({
      id,
      threadId: thread,
      agentId: "a1",
      blocking: true,
      request: ask,
      state: "pending",
      createdAt: 1,
    }),
    threadTitle: "Fix relay reconnect after sleep",
    project: "ace",
    provider: "claude",
  };
}

const command = request("i1", {
  kind: "approval",
  title: "bun --bun x vitest run apps/daemon/src/relay.device.process.test.ts",
  target: {
    tool: "Bash",
    access: "execute",
    command: "bun --bun x vitest run apps/daemon/src/relay.device.process.test.ts",
  },
  options: [
    { id: "once", label: "Yes", kind: "allow_once" },
    { id: "always", label: "Always", kind: "allow_always" },
    { id: "no", label: "No", kind: "deny" },
  ],
});
const question = request(
  "i2",
  {
    kind: "question",
    questions: [
      {
        id: "q1",
        text: "Which handle should the publisher profile use?",
        options: [
          { id: "o1", label: "arpan" },
          { id: "o2", label: "arpan404" },
        ],
      },
    ],
  },
  "t2",
);
const plan = request(
  "i3",
  { kind: "plan_review", title: "Relay plan", markdown: "1. Read\n2. Fix\n3. Test" },
  "t3",
);

function press(
  requests: readonly OpenRequest[],
  input: string,
  from: RequestsState = requestsStart,
) {
  let state = from;
  const effects: Effect[] = [];
  for (const key of decodeKeys(input)) {
    const next = requestsKey(state, requests, key);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const resolutions = (effects: readonly Effect[]) =>
  effects.flatMap((effect) =>
    effect.kind === "command" && effect.payload.type === "interaction.resolve"
      ? [effect.payload]
      : [],
  );

describe("answering requests from the terminal", () => {
  it("sends one interaction.resolve with the allow-once option when y answers an approval", () => {
    const { effects } = press([command], "y");
    expect(resolutions(effects)).toEqual([
      {
        type: "interaction.resolve",
        interactionId: "i1",
        resolution: { kind: "approval", optionId: "once" },
      },
    ]);
  });

  it("denies with n and always allows with a", () => {
    expect(resolutions(press([command], "n").effects)[0]?.resolution).toEqual({
      kind: "approval",
      optionId: "no",
    });
    expect(resolutions(press([command], "a").effects)[0]?.resolution).toEqual({
      kind: "approval",
      optionId: "always",
    });
  });

  it("asks for a deliberate yes on a high-risk command, and refuses with one key", () => {
    const risky = request("i9", {
      kind: "approval",
      title: "rm -rf /",
      target: { tool: "Bash", access: "execute", command: "rm -rf /" },
      options: [
        { id: "once", label: "Yes", kind: "allow_once" },
        { id: "no", label: "No", kind: "deny" },
      ],
    });
    const first = press([risky], "y");
    expect(resolutions(first.effects)).toEqual([]);
    expect(first.state.answer.mode).toBe("details");
    expect(resolutions(press([risky], "y", first.state).effects)).toHaveLength(1);
    expect(resolutions(press([risky], "n").effects)[0]?.resolution).toEqual({
      kind: "approval",
      optionId: "no",
    });
  });

  it("answers a question with a choice's number", () => {
    const { effects } = press([question], "2");
    expect(resolutions(effects)[0]?.resolution).toEqual({
      kind: "question",
      answers: { q1: ["o2"] },
    });
  });

  it("answers a question with typed words", () => {
    const { effects } = press([question], "3my-handle\r");
    expect(resolutions(effects)[0]?.resolution).toEqual({
      kind: "question",
      answers: { q1: ["my-handle"] },
    });
  });

  it("approves a plan, or asks for changes with feedback", () => {
    expect(resolutions(press([plan], "\ry").effects)[0]?.resolution).toEqual({
      kind: "plan_review",
      decision: "approve",
    });
    expect(resolutions(press([plan], "nsmaller steps\r").effects)[0]?.resolution).toEqual({
      kind: "plan_review",
      decision: "reject",
      feedback: "smaller steps",
    });
  });

  it("walks the requests one at a time and moves on after an answer", () => {
    const all = [command, question, plan];
    const view = requestsView(requestsStart, all, 100, 20, paint(false));
    expect(view.lines[0]).toContain("1 of 3");
    expect(view.lines.join("\n")).toContain("y Allow once");
    expect(view.lines.join("\n")).toContain("n Deny");
    expect(view.lines.join("\n")).toContain("a Always allow");
    const after = press(all, "y");
    const next = requestsView(after.state, all, 100, 20, paint(false));
    expect(next.lines[0]).toContain("1 of 2");
    expect(next.lines.join("\n")).toContain("1 arpan    2 arpan404    3 Type an answer");
    expect(press(all, "\x1b[C").state.index).toBe(1);
  });

  it("cuts a long command in the middle so its end stays", () => {
    const view = requestsView(requestsStart, [command], 50, 20, paint(false));
    const detail = view.lines.find((line) => line.includes("…"));
    expect(detail).toBeDefined();
    expect(detail?.trimEnd().endsWith("test.ts")).toBe(true);
  });

  it("goes back to the home on Esc", () => {
    expect(press([command], "\x1b").effects).toEqual([{ kind: "home" }]);
  });
});
