import { z } from "zod";
import type { McpAttribution } from "@ace/protocol";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import {
  acceptCheck,
  describeListing,
  marketOperation,
  marketPersonVerbs,
  marketPublishVerbs,
  marketReadVerbs,
  MarketVerbFields,
  MarketVerbProblem,
  type MarketVerbInput,
} from "./market-verbs.ts";
import type { Toolkit } from "./toolkits.ts";

/*
 * `market_read` and `market_publish` (ADR 0176 §12.5): the market for an agent, through the
 * daemon's `marketplace.request` as the asking thread. Publishing follows the provider's own
 * permissions (the tool says it reaches the world); the person-only actions come back as the
 * request ace opened in the thread. Spade reads their effects from `_meta` (ADR 0171).
 */

/** The daemon's market, asked as the agent in `caller.threadId`. */
export interface MarketToolPort {
  request(
    caller: McpAttribution,
    operation: MarketOperation,
    signal: AbortSignal,
  ): Promise<MarketResult>;
}

const ReadInput = MarketVerbFields.pick({
  type: true,
  name: true,
  source: true,
  query: true,
  category: true,
  handle: true,
  path: true,
  suit: true,
  draft: true,
  limit: true,
}).extend({ verb: z.enum(marketReadVerbs) });

const PublishInput = MarketVerbFields.omit({
  query: true,
  category: true,
  limit: true,
}).extend({
  verb: z.enum([...marketPublishVerbs, ...marketPersonVerbs]),
  confirm: z
    .boolean()
    .optional()
    .describe("draft_create: you read the check's findings and they may be public"),
});

type Answer = Record<string, unknown>;
/** A draft whose check found texts the caller must confirm may be public first. */
interface Confirm {
  readonly op: "confirm";
  readonly findings: readonly string[];
  readonly next: string;
}
const text = (value: Answer, failed = false) => ({
  ...(failed ? { isError: true } : {}),
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** A market answer as the agent reads it. */
function answer(result: MarketResult) {
  if (result.op !== "error") return text(result);
  if (result.code === "person_only")
    return text({
      status: "person",
      message: result.message,
      ...(result.request ? { request: result.request } : {}),
      next: "The person answers in your thread's strip; carry on without it or end your turn.",
    });
  return text(
    {
      code: result.code,
      message: result.message,
      ...(result.problems ? { problems: result.problems } : {}),
      ...(result.scan ? { scan: result.scan } : {}),
    },
    true,
  );
}

const problem = (error: MarketVerbProblem) =>
  text({ code: "invalid", field: error.field, message: error.message }, true);

/** Steps a verb takes beyond one operation: describe, install and a draft from a folder. */
async function publishVerb(
  input: MarketVerbInput & { confirm?: boolean | undefined },
  ask: (operation: MarketOperation) => Promise<MarketResult>,
): Promise<MarketResult | Confirm> {
  if (input.verb === "describe") {
    const current = await ask(marketOperation({ ...input, verb: "versions" }));
    if (current.op !== "publish" || current.answer.kind !== "entry") return current;
    return ask(describeListing(current.answer.entry.listing, input));
  }
  if (input.verb === "install") {
    const prepared = await ask(marketOperation(input));
    if (prepared.op !== "review") return prepared;
    const { review } = prepared;
    return ask({
      op: "install",
      id: review.id,
      hash: review.hash,
      choices: { bots: [], needs: {}, startRoutines: false },
    });
  }
  const operation = marketOperation(input);
  if (
    operation.op !== "publish" ||
    operation.request.action !== "draftCreate" ||
    operation.request.source.kind !== "folder"
  )
    return ask(operation);
  const draft = operation.request;
  const checked = await ask({
    op: "publish",
    request: { action: "draftCheck", type: draft.type, name: draft.name, source: draft.source },
  });
  if (checked.op !== "publish" || checked.answer.kind !== "checked") return checked;
  const { check } = checked.answer;
  const blocking = check.findings.find((finding) => finding.blocking);
  if (blocking)
    return { op: "error", code: "refused", message: blocking.sentence } satisfies MarketResult;
  if (check.findings.length > 0 && input.confirm !== true)
    return {
      op: "confirm",
      findings: check.findings.map((finding) => finding.sentence),
      next: "Read each finding: fix the files, or call again with confirm true to publish them.",
    };
  return ask({ ...operation, request: { ...draft, checked: acceptCheck(check) } });
}

export function marketToolkit(port: MarketToolPort): Toolkit {
  return {
    register(registry) {
      registry.registerContent({
        name: "market_read",
        title: "Read the market",
        description:
          "Search ace's market, read an entry, a publisher, what's installed, your own entries (status, versions, signals, drafts), or check a folder before publishing.",
        input: ReadInput,
        riskClass: "read-only",
        effect: "read",
        capability: null,
        timeoutMs: 60_000,
        async run(input, { caller, signal }) {
          try {
            return answer(await port.request(caller, marketOperation(input), signal));
          } catch (error) {
            if (error instanceof MarketVerbProblem) return problem(error);
            throw error;
          }
        },
      });
      registry.registerContent({
        name: "market_publish",
        title: "Publish to the market",
        description:
          "Make, update and delete drafts, and publish one. Everything else (listing words, changelog, latest, deprecate, visibility, archive, appeal, withdraw, transfer, handle, delete, verification, install) is the person's: ace asks them in your thread.",
        input: PublishInput,
        riskClass: "external-effect",
        openWorld: true,
        effect: "publish",
        capability: null,
        timeoutMs: 120_000,
        async run(input, { caller, signal }) {
          try {
            const result = await publishVerb(input, (operation) =>
              port.request(caller, operation, signal),
            );
            return result.op === "confirm"
              ? text({ status: "confirm", findings: result.findings, next: result.next })
              : answer(result);
          } catch (error) {
            if (error instanceof MarketVerbProblem) return problem(error);
            throw error;
          }
        },
      });
    },
  };
}
