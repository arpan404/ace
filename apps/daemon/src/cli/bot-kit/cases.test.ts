import { describe, expect, it } from "vitest";
import { CliFailure } from "../output.ts";
import type { SpadeExchange } from "../spade-call.ts";
import { costLine, replayLines, testCases } from "./cases.ts";

/*
 * `ace bot test --cases` against a stand-in for Spade's API: the replay it asks for, what it
 * prints, and that a model replay says its cost and spends nothing without a yes.
 */

const bots = { agents: [{ id: "bot_1", name: "Fare watcher", kind: "bot" }] };

function replay(failed: number) {
  return {
    replay: {
      mode: "wiring",
      cases: [
        { id: "case_1", given: "What does KTM to DEL cost?", passed: true, lines: [], outside: 0 },
        ...(failed
          ? [
              {
                id: "case_2",
                given: "Mail my agent the fare",
                mark: "right",
                passed: false,
                lines: ["send_message was refused: Fare watcher doesn't declare sending."],
                outside: 0,
              },
            ]
          : []),
      ],
      passed: 1,
      failed,
      outside: 0,
      summary: failed
        ? "1 of 2 kept runs replay the same. 1 doesn't: see why."
        : "The 1 kept run replays the same.",
    },
  };
}

/** Spade's API as `answers` gives it, by method and path; what was asked, in order. */
function spade(answers: Record<string, unknown>) {
  const asked: { method: string; path: string; body?: unknown }[] = [];
  const exchange: SpadeExchange = async (method, path, body) => {
    asked.push({ method, path, body });
    const key = `${method} ${path.split("?")[0]}`;
    const answer = answers[key];
    return answer === undefined
      ? { status: 404, body: '{"error":"no such route"}' }
      : { status: 200, body: JSON.stringify(answer) };
  };
  return { exchange, asked };
}

const never = async () => {
  throw new Error("a free replay asks nothing");
};

describe("ace bot test --cases", () => {
  it("replays the bot's kept runs on the folder's version and prints a line for each", async () => {
    const { exchange, asked } = spade({
      "GET /v1/agents": bots,
      "POST /v1/agents/bot_1/cases/replay": replay(0),
    });
    const version = { recipe: { name: "Fare watcher" }, pages: {} };
    const report = await testCases(exchange, "fare watcher", { version, confirm: never });
    expect(report.passed).toBe(true);
    expect(asked.at(-1)).toEqual({
      method: "POST",
      path: "/v1/agents/bot_1/cases/replay",
      body: version,
    });
    expect(replayLines(report)).toEqual([
      "✓ What does KTM to DEL cost?",
      "The 1 kept run replays the same.",
    ]);
  });

  it("fails with each kept run that didn't replay the same as a problem", async () => {
    const { exchange } = spade({
      "GET /v1/agents": bots,
      "POST /v1/agents/bot_1/cases/replay": replay(1),
    });
    const failure = await testCases(exchange, "bot_1", { confirm: never }).catch((e) => e);
    expect(failure).toBeInstanceOf(CliFailure);
    expect(failure.message).toBe("1 of 2 kept runs replay the same. 1 doesn't: see why.");
    expect(failure.detail.problems).toEqual([
      {
        path: "case_2",
        message:
          "Mail my agent the fare: send_message was refused: Fare watcher doesn't declare sending.",
      },
    ]);
  });

  it("says what a model replay costs and runs nothing without a yes", async () => {
    const estimate = {
      estimate: {
        model: "work/fast",
        model_name: "Fast",
        cases: 20,
        cost_micros: 120_000,
        priced: true,
      },
    };
    const { exchange, asked } = spade({
      "GET /v1/agents": bots,
      "GET /v1/agents/bot_1/cases/replay": estimate,
      "POST /v1/agents/bot_1/cases/replay": replay(0),
    });
    const said: string[] = [];
    const refuse = async (_question: string, lines: readonly string[]) => {
      said.push(...lines);
      return false;
    };
    const failure = await testCases(exchange, "bot_1", { model: "fast", confirm: refuse }).catch(
      (e) => e,
    );
    expect(failure).toBeInstanceOf(CliFailure);
    expect(failure.outcome).toBe("needs-human");
    expect(said).toEqual(["Replaying 20 kept runs on Fast costs about $0.12, on your account."]);
    expect(asked.some((call) => call.method === "POST")).toBe(false);
    const report = await testCases(exchange, "bot_1", { model: "fast", confirm: async () => true });
    expect(report.passed).toBe(true);
    expect(asked.at(-1)?.body).toEqual({ model: "fast" });
  });

  it("says plainly when a model's price isn't known", () => {
    expect(
      costLine({ model: "local/llama", model_name: "", cases: 1, cost_micros: 0, priced: false }),
    ).toBe("Replaying 1 kept run on local/llama, whose price Spade doesn't know.");
  });
});
