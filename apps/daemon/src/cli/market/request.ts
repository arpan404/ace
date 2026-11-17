import type { CliErrorCode, CliProblem } from "@ace/protocol/cli-output";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { CliFailure, type Outcome } from "../output.ts";
import { ownThread, withSession, type CommandContext } from "../run/context.ts";

/*
 * Every people and publisher market command goes through the daemon's `marketplace.request`
 * (ADR 0176 §11), never to market.acehq.dev, so this machine's sources, signature checks, scan
 * and signed-in ace account are the ones used. In an agent's shell the request names its thread
 * (`ACE_THREAD_ID`), and the daemon turns a person-only action into a request there.
 */

type MarketError = Extract<MarketResult, { op: "error" }>;
export type MarketAnswer = Exclude<MarketResult, { op: "error" }>;

const outcomes: Readonly<Record<MarketError["code"], readonly [Outcome, CliErrorCode]>> = {
  signed_out: ["needs-human", "signed_out"],
  reauth: ["needs-human", "reauth"],
  person_only: ["needs-human", "person_only"],
  blocked: ["failed", "blocked"],
  suspended: ["refused", "suspended"],
  quota: ["refused", "quota"],
  forbidden: ["refused", "forbidden"],
  conflict: ["refused", "conflict"],
  not_found: ["refused", "not_found"],
  invalid: ["refused", "refused"],
  refused: ["refused", "refused"],
  unavailable: ["refused", "turned_off"],
  busy: ["refused", "busy"],
  expired: ["failed", "failed"],
  failed: ["failed", "failed"],
};

const hints: Partial<Record<MarketError["code"], string>> = {
  signed_out: "Sign in with ace login, then run it again.",
  reauth: "Sign in again with ace login, then run it again.",
  unavailable: "Turn the marketplace on with ace features on marketplace.",
  expired: "The review ran out; run the command again for a fresh one.",
};

/** The market's refusal as the CLI reports it (ADR 0176 §12.3–§12.4). Pure. */
export function marketFailure(error: MarketError): CliFailure {
  const [outcome, code] = outcomes[error.code];
  const findings: CliProblem[] = (error.scan?.findings ?? [])
    .filter((finding) => finding.level !== "note")
    .map((finding) => {
      const problem: CliProblem = { message: finding.message };
      if (finding.path) problem.path = finding.path;
      if (finding.line) problem.line = finding.line;
      return problem;
    });
  const problems = [...(error.problems ?? []), ...findings];
  const message =
    error.code === "signed_out" ? "Sign in to publish." : error.message.trim() || error.code;
  const hint =
    error.code === "blocked"
      ? "The draft is kept. Fix the files and update it, or ask for a look with ace market appeal REF@VERSION --note TEXT."
      : hints[error.code];
  return new CliFailure(outcome, message, error.scan ? { scan: error.scan } : undefined, {
    code,
    ...(hint ? { hint } : {}),
    ...(problems.length ? { problems } : {}),
    ...(error.request ? { request: error.request } : {}),
  });
}

/** Asks the daemon; an error result throws as the CLI's failure. */
export type MarketAsk = (operation: MarketOperation) => Promise<MarketAnswer>;

/** One daemon connection for a command's market requests. */
export async function withMarket<T>(
  context: CommandContext,
  run: (ask: MarketAsk) => Promise<T>,
): Promise<T> {
  const thread = ownThread(context);
  let finished: { value: T } | undefined;
  await withSession(context, context.args, async ({ client, signal }) => {
    const ask: MarketAsk = async (operation) => {
      const reply = await client.request(
        { type: "marketplace.request", operation, ...(thread ? { thread } : {}) },
        { signal },
      );
      if (reply.result.op === "error") throw marketFailure(reply.result);
      return reply.result;
    };
    finished = { value: await run(ask) };
  });
  if (!finished) throw new CliFailure("failed", "The market request didn't finish.");
  return finished.value;
}

/** The answer a request must give, or the CLI fails saying what came back instead. */
export function answerOf<K extends MarketAnswer["op"]>(
  answer: MarketAnswer,
  op: K,
): Extract<MarketAnswer, { op: K }> {
  if (answer.op !== op)
    throw new CliFailure("failed", `The daemon answered ${answer.op}, not ${op}.`);
  return answer as Extract<MarketAnswer, { op: K }>;
}
