import { Interaction, InteractionRequest, type InteractionResolution } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import {
  answerRefusal,
  requestChars,
  sentSummarized,
  summarizeInteraction,
  wholeRequestChars,
} from "./interaction-summary.ts";

const huge = (char: string) => char.repeat(wholeRequestChars + 1);

const interaction = (request: unknown, extra: Record<string, unknown> = {}) =>
  Interaction.parse({
    id: "i1",
    threadId: "t1",
    agentId: "root",
    blocking: true,
    request,
    state: "pending",
    createdAt: 1,
    raw: [{ type: "permission", data: { note: "raw" } }],
    ...extra,
  });

const approval = (description: string, options?: unknown[]) => ({
  kind: "approval",
  title: "Run the build",
  description,
  target: { tool: "Bash", command: "make", access: "execute" },
  options: options ?? [
    { id: "allow", label: "Allow once", kind: "allow_once" },
    { id: "deny", label: "Deny", kind: "deny" },
  ],
});

/** Every kind of request, each with a part far over the bound. */
const oversized: Record<string, unknown> = {
  approval: {
    ...approval(huge("d")),
    target: {
      tool: "Edit",
      access: "write",
      command: "c".repeat(32_000),
      paths: Array.from({ length: 128 }, (_, index) => `${"p".repeat(4000)}${index}`),
      input: { file: "a.ts", content: huge("x") },
    },
    permissionUpdates: [{ rule: huge("r") }],
  },
  question: {
    kind: "question",
    questions: Array.from({ length: 500 }, (_, index) => ({
      id: `q${index}`,
      text: "Which one? ".repeat(400),
      options: Array.from({ length: 200 }, (_entry, option) => ({
        id: `q${index}:${option}`,
        label: "l".repeat(400),
        description: "d".repeat(4000),
      })),
    })),
  },
  plan_review: {
    kind: "plan_review",
    title: "The plan",
    markdown: huge("m"),
    todos: Array.from({ length: 5000 }, (_, index) => ({
      content: `step ${index} `.repeat(50),
      status: "pending",
    })),
  },
  elicitation: {
    kind: "elicitation",
    server: "github",
    message: huge("e"),
    url: `https://example.com/${"u".repeat(10_000)}`,
    schema: { type: "object", properties: { big: { description: huge("s") } } },
  },
};

describe("requests sent with their thread", () => {
  it("a request within the bound goes whole, raw payloads and all", () => {
    const small = interaction(approval("d".repeat(10_000)));
    expect(summarizeInteraction(small)).toEqual(small);
    expect(sentSummarized(small)).toBe(false);
  });

  it.each(Object.entries(oversized))(
    "a %s request over the bound goes as a small summary that says how large the whole is",
    (_kind, request) => {
      const whole = interaction(request);
      const summary = summarizeInteraction(whole);
      expect(summary.truncated).toEqual({ chars: requestChars(whole.request) });
      expect(summary.raw).toEqual([]);
      expect(JSON.stringify(summary).length).toBeLessThan(wholeRequestChars);
      // Still a request a client can parse and show.
      expect(InteractionRequest.safeParse(summary.request).success).toBe(true);
      expect(summary.request.kind).toBe(whole.request.kind);
      expect(sentSummarized(summary)).toBe(true);
    },
  );

  it("a summary's text is the start of the whole text and ends marked as cut", () => {
    const description = `${"start ".repeat(10)}${huge("d")}`;
    const summary = summarizeInteraction(interaction(approval(description)));
    if (summary.request.kind !== "approval") throw new Error("not an approval");
    const shown = summary.request.description ?? "";
    expect(shown.endsWith("…")).toBe(true);
    expect(description.startsWith(shown.slice(0, -1))).toBe(true);
  });

  it("a summary never splits a character made of two code units", () => {
    const summary = summarizeInteraction(interaction(approval("😀".repeat(wholeRequestChars))));
    if (summary.request.kind !== "approval") throw new Error("not an approval");
    const shown = summary.request.description ?? "";
    expect(shown.slice(0, -1)).toBe("😀".repeat((shown.length - 1) / 2));
  });

  it("a summary keeps every decline, however many options come before it", () => {
    const options = [
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `allow${index}`,
        label: "Allow",
        kind: "allow_once",
      })),
      { id: "deny", label: "Deny", kind: "deny" },
      { id: "cancel", label: "Cancel", kind: "cancel" },
    ];
    const summary = summarizeInteraction(interaction(approval(huge("d"), options)));
    if (summary.request.kind !== "approval") throw new Error("not an approval");
    const ids = summary.request.options.map((option) => option.id);
    expect(ids).toContain("deny");
    expect(ids).toContain("cancel");
  });

  it("an address too long to send whole is left out, never cut", () => {
    const summary = summarizeInteraction(interaction(oversized.elicitation));
    if (summary.request.kind !== "elicitation") throw new Error("not an elicitation");
    expect(summary.request.url).toBeUndefined();
    expect(summary.request.schema).toBeUndefined();
  });

  it("a copy that is a summary already goes as it is", () => {
    const mirrored = interaction(approval("short"), { truncated: { chars: 9_000_000 } });
    expect(summarizeInteraction(mirrored)).toEqual(mirrored);
    expect(sentSummarized(mirrored)).toBe(true);
  });
});

describe("answers to requests sent summarized", () => {
  const large = interaction(approval(huge("d")));
  const small = interaction(approval("short"));
  const mirrored = interaction(approval("short"), { truncated: { chars: 9_000_000 } });
  const allow: InteractionResolution = { kind: "approval", optionId: "allow" };
  const deny: InteractionResolution = { kind: "approval", optionId: "deny" };
  const cases: [string, Interaction, InteractionResolution, boolean, string | undefined][] = [
    ["an allow, not shown whole, is refused", large, allow, false, "request_not_read"],
    ["an allow, shown whole, goes", large, allow, true, undefined],
    ["a deny never needs the whole request", large, deny, false, undefined],
    ["an allow of a request sent whole goes", small, allow, false, undefined],
    ["an allow of a mirrored summary is refused", mirrored, allow, true, "request_not_read"],
    ["a deny of a mirrored summary goes", mirrored, deny, false, undefined],
    [
      "an option the request doesn't list counts as an allow",
      large,
      { kind: "approval", optionId: "other" },
      false,
      "request_not_read",
    ],
  ];
  it.each(cases)("%s", (_name, asked, resolution, readWhole, refusal) => {
    expect(answerRefusal(asked, resolution, readWhole)).toBe(refusal);
  });

  it.each([
    ["plan approved", oversized.plan_review, { kind: "plan_review", decision: "approve" }, true],
    ["plan rejected", oversized.plan_review, { kind: "plan_review", decision: "reject" }, false],
    ["questions answered", oversized.question, { kind: "question", answers: {} }, true],
    [
      "questions dismissed",
      oversized.question,
      { kind: "question", answers: {}, dismissed: true },
      false,
    ],
    ["form accepted", oversized.elicitation, { kind: "elicitation", action: "accept" }, true],
    ["form declined", oversized.elicitation, { kind: "elicitation", action: "decline" }, false],
  ] as const)("%s needs the whole request first: %s", (_name, request, resolution, needs) => {
    expect(answerRefusal(interaction(request), resolution, false) !== undefined).toBe(needs);
  });
});
