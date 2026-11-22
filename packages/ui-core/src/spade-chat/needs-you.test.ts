import { describe, expect, it } from "vitest";
import { spadeBotRow } from "./list-rows.ts";
import { spadeNeedsYouWords } from "./needs-you.ts";

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
    const base = { name: "Trip planner", state: "waiting" } as Parameters<typeof spadeBotRow>[0];
    expect(spadeBotRow({ ...base, waitingFor: "question" }).line).toBe("Needs you");
    expect(spadeBotRow({ ...base, waitingFor: "approval", status: "Wants to send an email" }).line).toBe(
      "Wants to send an email",
    );
  });
});
