import { describe, expect, it } from "vitest";
import { parseSpadeReplay, replayFailures, replayOffer } from "./replays.ts";

describe("a replay of a bot's kept runs", () => {
  it("reads Spade's answer and lists each run that didn't replay the same with its first reason", () => {
    const replay = parseSpadeReplay({
      replay: {
        mode: "wiring",
        cases: [
          { id: "case_1", given: "Check fares", passed: true, lines: [] },
          {
            id: "case_2",
            given: "Mail my agent the fare",
            passed: false,
            lines: ["send_message was refused: it doesn't declare sending.", "second reason"],
          },
          { id: "case_3", passed: false },
        ],
        passed: 1,
        failed: 2,
        outside: 0,
        summary: "1 of 3 kept runs replay the same. 2 don't: see why.",
        later_field: true,
      },
    });
    expect(replay?.summary).toBe("1 of 3 kept runs replay the same. 2 don't: see why.");
    expect(replay && replayFailures(replay)).toEqual([
      {
        given: "Mail my agent the fare",
        why: "send_message was refused: it doesn't declare sending.",
      },
      { given: "A kept run", why: "It didn't replay the same." },
    ]);
    expect(parseSpadeReplay({ error: "no" })).toBeUndefined();
  });

  it("offers a model replay with its cost from the person's prices, or says the price is unknown", () => {
    const estimate = { model: "work/fast", model_name: "Fast", cases: 20, priced: true };
    expect(replayOffer({ ...estimate, cost_micros: 120_000 })).toBe(
      "Try it on your last 20 kept runs: about $0.12 on Fast.",
    );
    expect(replayOffer({ ...estimate, cost_micros: 0, cases: 1 })).toBe(
      "Try it on your last kept run: free on Fast.",
    );
    expect(replayOffer({ ...estimate, cost_micros: 0, priced: false })).toBe(
      "Try it on your last 20 kept runs on Fast, whose price Spade doesn't know.",
    );
    expect(replayOffer({ ...estimate, cost_micros: 0, cases: 0 })).toBeUndefined();
  });
});
