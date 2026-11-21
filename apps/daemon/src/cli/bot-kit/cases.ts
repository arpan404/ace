import type { CliProblem } from "@ace/protocol/cli-output";
import { CliBotReplay, type CliBotTest } from "@ace/protocol/cli-outputs";
import { z } from "zod";
import { CliFailure, usageFailure } from "../output.ts";
import { answerFailure, type SpadeExchange } from "../spade-call.ts";
import { botsNamed, listedBots, type ListedBot } from "./from-bot.ts";

/*
 * `ace bot test --cases BOT [PATH]` (ADR 0204 §2): replays the runs the person kept as tests of
 * one of their bots, on the version in PATH or the one the bot runs. Free by default: the recorded
 * steps on a scripted model, every outside call answered from the recording. `--model ROLE` runs
 * them on one of the person's models instead, at their cost, which is said first and needs their
 * yes. Spade does the replaying; this reads the folder, asks and prints.
 */

/** Spade's answer to a replay: `{replay}`. */
const ReplayAnswer = z.object({ replay: CliBotReplay });

const Estimate = z.object({
  estimate: z.object({
    model: z.string(),
    model_name: z.string().catch(""),
    cases: z.number().int().nonnegative(),
    cost_micros: z.number().int().nonnegative(),
    priced: z.boolean().catch(false),
  }),
});
type Estimate = z.infer<typeof Estimate>["estimate"];

/** The version a replay installs, read from a package folder. */
export interface FolderVersion {
  recipe: unknown;
  pages: Record<string, string>;
}

export interface CasesOptions {
  /** The version to replay on; the bot's own when undefined. */
  version?: FolderVersion | undefined;
  /** A model replay's model (`current`, a role, or `endpoint/model`). */
  model?: string | undefined;
  /** Asked before a model replay spends anything; false refuses it. */
  confirm: (question: string, lines: readonly string[]) => Promise<boolean>;
}

const json = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** Dollars from millionths, the way the update review says them. Pure. */
export function dollars(micros: number): string {
  if (micros === 0) return "nothing";
  if (micros < 10_000) return "under $0.01";
  return `about $${(micros / 1e6).toFixed(2)}`;
}

/** The line that says what a model replay costs before it runs. Pure. */
export function costLine(estimate: Estimate): string {
  const runs = `${estimate.cases} kept run${estimate.cases === 1 ? "" : "s"}`;
  const name = estimate.model_name || estimate.model;
  if (!estimate.priced) return `Replaying ${runs} on ${name}, whose price Spade doesn't know.`;
  return `Replaying ${runs} on ${name} costs ${dollars(estimate.cost_micros)}, on your account.`;
}

/** Each kept run that didn't replay the same, as problems. Pure. */
export function replayProblems(replay: CliBotReplay): CliProblem[] {
  return replay.cases
    .filter((replayed) => !replayed.passed)
    .flatMap((replayed) =>
      replayed.lines.map((line) => ({ path: replayed.id, message: `${replayed.given}: ${line}` })),
    );
}

/** `ace bot test --cases`'s lines. Pure. */
export function replayLines(report: CliBotTest): string[] {
  const replay = report.replay;
  if (!replay) return [];
  return [
    ...replay.cases.map((replayed) =>
      replayed.passed
        ? `✓ ${replayed.given}`
        : `✗ ${replayed.given}: ${replayed.lines[0] ?? "it didn't replay the same"}`,
    ),
    replay.summary,
  ];
}

async function oneBot(exchange: SpadeExchange, wanted: string): Promise<ListedBot> {
  const listed = await exchange("GET", "/v1/agents");
  if (listed.status !== 200) throw answerFailure(listed);
  const found = botsNamed(listedBots(json(listed.body)), wanted);
  if (found.length === 0)
    throw new CliFailure("refused", `No bot here is called ${wanted}.`, undefined, {
      code: "not_found",
      hint: "See your bots with ace spade bots.",
    });
  if (found.length > 1)
    throw usageFailure(`More than one bot is called ${wanted}.`, {
      argument: "--cases",
      hint: `Pass its id instead: ${found.map((bot) => bot.id).join(", ")}.`,
    });
  return found[0] as ListedBot;
}

/** Replays `wanted`'s kept runs; the report, or a failure carrying the runs that differ. */
export async function testCases(
  exchange: SpadeExchange,
  wanted: string,
  options: CasesOptions,
): Promise<CliBotTest> {
  const bot = await oneBot(exchange, wanted);
  const path = `/v1/agents/${encodeURIComponent(bot.id)}/cases/replay`;
  if (options.model) {
    const asked = await exchange("GET", `${path}?model=${encodeURIComponent(options.model)}`);
    if (asked.status !== 200) throw answerFailure(asked);
    const estimate = Estimate.safeParse(json(asked.body));
    if (!estimate.success) throw new CliFailure("failed", "Spade's estimate didn't make sense.");
    const line = costLine(estimate.data.estimate);
    if (!(await options.confirm("Run it?", [line])))
      throw new CliFailure("needs-human", line, undefined, {
        code: "confirm",
        hint: "Run it in your own terminal to answer, or pass --yes.",
      });
  }
  const body = {
    ...(options.version ? options.version : {}),
    ...(options.model ? { model: options.model } : {}),
  };
  const answer = await exchange("POST", path, body);
  if (answer.status !== 200) throw answerFailure(answer);
  const read = ReplayAnswer.safeParse(json(answer.body));
  if (!read.success) throw new CliFailure("failed", "Spade's replay report didn't make sense.");
  const replay = read.data.replay;
  const report: CliBotTest = {
    name: bot.name,
    passed: replay.failed === 0,
    problems: [],
    scenarios: [],
    replay,
  };
  if (report.passed) return report;
  throw new CliFailure("failed", replay.summary, report, {
    code: "check_failed",
    problems: replayProblems(replay),
  });
}
