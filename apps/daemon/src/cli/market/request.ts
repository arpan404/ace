import { agentMayRun } from "../../marketplace/agent-gate.ts";
import { agentShell, personOnlyRefusal } from "../person-gate.ts";
import type { CliErrorCode, CliProblem } from "@ace/protocol/cli-output";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { CliFailure, type Outcome } from "../output.ts";
import { ownThread, withSession, type CommandContext } from "../run/context.ts";

/*
 * Every people and publisher market command goes through the daemon's `marketplace.request`
 * (ADR 0178 §11), never to market.acehq.dev, so this machine's sources, signature checks, scan
 * and signed-in ace account are the ones used. In an agent's shell the request names its thread
 * (`ACE_THREAD_ID`), and the daemon turns a person-only action into a request there.
 */

type MarketError = Extract<MarketResult, { op: "error" }>;
export type MarketAnswer = Exclude<MarketResult, { op: "error" }>;

const outcomes: Readonly<Record<MarketError["code"], readonly [Outcome, CliErrorCode]>> = {
  signed_out: ["needs-human", "signed_out"],
  reauth: ["needs-human", "reauth"],
  person_only: ["needs-human", "person_only"],
  // The CLI never holds the person's session (ADR 0190): only an app they signed in on can.
  person_grant: ["needs-human", "person_only"],
  // An organization's registry needs the person's app: its membership check and its key trust.
  not_member: ["needs-human", "person_only"],
  registry_trust: ["needs-human", "person_only"],
  blocked: ["failed", "blocked"],
  suspended: ["refused", "suspended"],
  quota: ["refused", "quota"],
  forbidden: ["refused", "forbidden"],
  conflict: ["refused", "conflict"],
  not_found: ["refused", "not_found"],
  invalid: ["refused", "refused"],
  refused: ["refused", "refused"],
  // The market, the account service or a part of ace couldn't be reached; nothing was changed.
  unavailable: ["refused", "refused"],
  busy: ["refused", "busy"],
  expired: ["failed", "failed"],
  failed: ["failed", "failed"],
};

const hints: Partial<Record<MarketError["code"], string>> = {
  signed_out: "Sign in with ace login, then run it again.",
  reauth: "Do this in the ace app signed in as you: the CLI can't prove it's you.",
  person_grant: "Do this in an ace app you're signed in on: the market takes it only from you.",
  not_member:
    "Install from an organization's registry in an ace app signed in to that organization.",
  registry_trust: "Trust the organization's registry key in an ace app, on this machine.",
  unavailable:
    "Nothing was changed. Try again shortly; ace account status shows whether this machine is signed in.",
  expired: "The review ran out; run the command again for a fresh one.",
};

/** The market's refusal as the CLI reports it (ADR 0178 §12.3–§12.4). Pure. */
/**
 * `unavailable` also answers a marketplace turned off in Settings › Beta (`TurnedOff` in the
 * daemon, which says so in these words); that one alone is `turned_off`, with the switch's hint.
 */
const turnedOff = (error: MarketError) =>
  error.code === "unavailable" &&
  (error.message.startsWith("The marketplace is turned off") ||
    error.message === "market.acehq.dev is turned off");

export function marketFailure(error: MarketError): CliFailure {
  const [outcome, mapped] = outcomes[error.code];
  const code = turnedOff(error) ? "turned_off" : mapped;
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
      : turnedOff(error)
        ? error.message.startsWith("market.acehq.dev")
          ? "Turn the source back on with ace market source on market."
          : "Turn the marketplace on with ace features on marketplace."
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
      // No thread to ask the person in: an agent's shell runs only the agents' allowlist.
      if (!thread && agentShell(context.env) && !agentMayRun(operation, true))
        throw personOnlyRefusal("market", { agent: true, interactive: false });
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
