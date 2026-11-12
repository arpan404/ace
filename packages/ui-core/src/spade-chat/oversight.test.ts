import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeActivity,
  parseSpadeAgent,
  parseSpadeLiveFrame,
  parseSpadeOversight,
  spadeActivitySearch,
  spadeActivityWords,
  spadeBubbles,
  spadeMicrosOf,
  spadeMoney,
  spadeView,
} from "./index.ts";

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame(
      "stored",
      JSON.stringify({ seq: ++seq, at: 1000 + seq, event }),
    );
    if (input) foldSpade(state, input);
  };
  return { stored, bubbles: () => spadeBubbles(spadeView(state)) };
}

const agentBody = (fields: Record<string, unknown>) =>
  JSON.stringify({
    agent: { id: "a1", name: "Research", model: "x/y", conversation: "c1", ...fields },
  });

describe("spending", () => {
  test("a bot's spend, caps and the cap it is at are read; null caps mean no cap", () => {
    const agent = parseSpadeAgent(
      agentBody({
        spending: {
          today_micros: 420_000,
          month_micros: 3_100_000,
          daily_cap_micros: 1_000_000,
          monthly_cap_micros: null,
          capped: "daily",
          resets_at: 1_794_200_000_000,
        },
        review: true,
      }),
    );
    expect(agent?.spending).toEqual({
      todayMicros: 420_000,
      monthMicros: 3_100_000,
      dailyCapMicros: 1_000_000,
      monthlyCapMicros: undefined,
      capped: "daily",
      resetsAt: 1_794_200_000_000,
    });
    expect(agent?.review).toBe(true);
  });

  test("a bot from a Spade without caps still reads, following the review default", () => {
    const agent = parseSpadeAgent(agentBody({ review: null, spending: "nonsense" }));
    expect(agent?.name).toBe("Research");
    expect(agent?.spending).toBeUndefined();
    expect(agent?.review).toBeUndefined();
  });

  test("a capped value this client doesn't know reads as not capped", () => {
    const agent = parseSpadeAgent(agentBody({ spending: { today_micros: 5, capped: "weekly" } }));
    expect(agent?.spending?.capped).toBeUndefined();
    expect(agent?.spending?.todayMicros).toBe(5);
  });

  test("money shows cents, and a spend under a cent never reads as free", () => {
    expect(spadeMoney(1_000_000)).toBe("$1.00");
    expect(spadeMoney(12_345_678)).toBe("$12.35");
    expect(spadeMoney(4_000)).toBe("<$0.01");
    expect(spadeMoney(0)).toBe("$0.00");
  });

  test("typed dollars become micros; empty is no cap and nonsense is refused", () => {
    expect(spadeMicrosOf("2.50")).toBe(2_500_000);
    expect(spadeMicrosOf("$1")).toBe(1_000_000);
    expect(spadeMicrosOf("  ")).toBeUndefined();
    expect(spadeMicrosOf("-1")).toBeNull();
    expect(spadeMicrosOf("abc")).toBeNull();
  });

  test("oversight reads the service's cap, spend and review default", () => {
    expect(
      parseSpadeOversight(
        JSON.stringify({
          oversight: {
            time_zone: "Europe/Berlin",
            daily_cap_micros: 5_000_000,
            today_micros: 1,
            month_micros: 2,
            review_default: true,
            review_model: null,
          },
        }),
      ),
    ).toMatchObject({
      timeZone: "Europe/Berlin",
      dailyCapMicros: 5_000_000,
      reviewDefault: true,
      reviewModel: undefined,
    });
    expect(parseSpadeOversight("{}")).toBeUndefined();
  });
});

const words = (fields: Record<string, unknown>) =>
  spadeActivityWords(
    parseSpadeActivity(JSON.stringify({ entries: [{ id: "1", seq: 1, ...fields }] }))?.entries[0] ??
      (undefined as never),
  ).sentence;

describe("activity", () => {
  test("entries are read newest first as sent; one without an id is left out", () => {
    const page = parseSpadeActivity(
      JSON.stringify({
        entries: [
          {
            id: "41-0",
            seq: 41,
            at: 5,
            kind: "tool",
            name: "web_fetch",
            summary: "url: https://example.com/page",
            outcome: "error",
            cost_micros: null,
          },
          { seq: 40, kind: "tool" },
          {
            id: "39-0",
            seq: 39,
            kind: "spend",
            summary: "3 steps",
            outcome: "finished",
            cost_micros: 23_000,
          },
          { id: "38-0", seq: 38, kind: "telepathy", name: "web_search", outcome: "ok" },
        ],
        more: true,
      }),
    );
    expect(page?.more).toBe(true);
    expect(page?.entries.map(spadeActivityWords)).toEqual([
      { sentence: "Read a web page", detail: "url: https://example.com/page", facts: "Failed" },
      { sentence: "Finished a turn", detail: "3 steps", facts: "$0.02" },
      { sentence: "Searched the web", detail: undefined, facts: undefined },
    ]);
  });

  test("each kind reads as one sentence about what the bot did", () => {
    expect(words({ kind: "connector", name: "slack__send_message", outcome: "ok" })).toBe(
      "Used send message in slack",
    );
    expect(words({ kind: "bot", name: "Travel", outcome: "received" })).toBe("Message from Travel");
    expect(words({ kind: "approval", name: "send_email", outcome: "asked" })).toBe(
      "Asked you to send an email",
    );
    expect(words({ kind: "review", name: "send_email", outcome: "escalated" })).toBe(
      "The review asked you before it would send an email",
    );
    expect(words({ kind: "cap", name: "monthly" })).toBe("Reached its monthly cap");
  });

  test("the query sends only the parts that are set", () => {
    expect(spadeActivitySearch({ kinds: ["tool", "file"], q: " flight ", before: 41 })).toBe(
      "?kind=tool%2Cfile&q=flight&before=41",
    );
    expect(spadeActivitySearch({})).toBe("");
  });
});

describe("the chat", () => {
  test("a reached cap is one bubble of the bot's, once per period", () => {
    const c = conversation();
    const cap = {
      type: "cap_reached",
      scope: "daily",
      cap_micros: 1_000_000,
      period_start: 1_794_100_000_000,
      resets_at: 1_794_186_400_000,
    };
    c.stored(cap);
    c.stored(cap);
    const bubbles = c.bubbles();
    expect(bubbles.map((bubble) => (bubble.kind === "bot" ? bubble.text : bubble.kind))).toEqual([
      "I've reached my daily spending cap of $1.00, so I've stopped until midnight. You can raise it in my settings.",
    ]);
  });

  test("an escalated call's approval says why the review asked", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "k1", name: "send_email", arguments: {} }],
    });
    c.stored({
      type: "call_reviewed",
      reply: "r1",
      call_id: "k1",
      name: "send_email",
      verdict: "escalate",
      reason: "You never asked for an email to this address.",
      model: "x/fast",
      cost_micros: 300,
    });
    c.stored({ type: "approval_requested", reply: "r1", call_id: "k1", name: "send_email" });
    const ask = c.bubbles().find((bubble) => bubble.kind === "ask");
    expect(ask?.kind === "ask" && ask.reason).toBe("You never asked for an email to this address.");
  });

  test("an allowed review adds nothing to the chat", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "call_reviewed", reply: "r1", call_id: "k1", verdict: "allow", reason: "ok" });
    c.stored({ type: "reply_finished", reply: "r1", text: "" });
    expect(c.bubbles()).toEqual([]);
  });

  test("a report a job kept is a chip on the bot's next bubble", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Research flights" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "On it." });
    c.stored({ type: "reply_finished", reply: "r1", text: "On it." });
    c.stored({
      type: "job_finished",
      job: "k1",
      name: "research",
      files: ["research/2026-11-12-flights.md"],
    });
    // Before the bot says anything, the chip stands on its own.
    expect(c.bubbles().at(-1)).toMatchObject({
      kind: "files",
      paths: ["research/2026-11-12-flights.md"],
    });
    c.stored({ type: "reply_started", reply: "r2" });
    c.stored({ type: "step_finished", reply: "r2", text: "Here is the report." });
    c.stored({ type: "reply_finished", reply: "r2", text: "Here is the report." });
    const bots = c.bubbles().filter((bubble) => bubble.kind === "bot");
    expect(bots.map((bubble) => bubble.kind === "bot" && bubble.files)).toEqual([
      undefined,
      ["research/2026-11-12-flights.md"],
    ]);
    expect(c.bubbles().some((bubble) => bubble.kind === "files")).toBe(false);
  });

  test("a file a tool kept mid-reply goes on the words that follow it", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Writing it down.",
      calls: [{ id: "k1", name: "workspace_write" }],
    });
    c.stored({ type: "tool_started", reply: "r1", call_id: "k1", name: "workspace_write" });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "k1",
      name: "workspace_write",
      files: ["notes/plan.md"],
    });
    c.stored({ type: "step_finished", reply: "r1", text: "Saved your plan." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Saved your plan." });
    expect(
      c.bubbles().map((bubble) => (bubble.kind === "bot" ? [bubble.text, bubble.files] : [])),
    ).toEqual([
      ["Writing it down.", undefined],
      ["Saved your plan.", ["notes/plan.md"]],
    ]);
  });
});
