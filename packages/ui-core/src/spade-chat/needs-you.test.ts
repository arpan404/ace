import { describe, expect, it } from "vitest";
import { spadeBotRow } from "./list-rows.ts";
import { spadeNeedsYouRunning, spadeNeedsYouWords } from "./needs-you.ts";

describe("what a waiting bot says it needs", () => {
  it("says what is asked in its own few words", () => {
    expect(spadeNeedsYouWords("Asks about the hotel")).toBe("Asks about the hotel");
  });

  it("falls back to Needs you when it says nothing", () => {
    expect(spadeNeedsYouWords(undefined)).toBe("Needs you");
    expect(spadeNeedsYouWords("  ")).toBe("Needs you");
    expect(spadeNeedsYouWords("Waiting for you")).toBe("Needs you");
    expect(spadeNeedsYouWords("Asked you a question")).toBe("Needs you");
  });

  it("reads the same on a bot row whether it asked a question or something else", () => {
    const base = { name: "Trip planner", state: "waiting", pending: [] } as Parameters<typeof spadeBotRow>[0];
    expect(spadeBotRow({ ...base, waitingFor: "question" }).line).toBe("Needs you");
    expect(
      spadeBotRow({ ...base, waitingFor: "approval", status: "Wants to send an email" }).line,
    ).toBe("Wants to send an email");
  });
});

describe("the Running page's line for a bot that waits", () => {
  it("says what it asks in the same words as the list", () => {
    expect(spadeNeedsYouRunning("Waiting on you: a question")).toBe("Asks you a question");
    expect(spadeNeedsYouRunning("Waiting on you: an approval")).toBe("Asks for your approval");
    expect(spadeNeedsYouRunning("Waiting on you")).toBe("Needs you");
  });
});
