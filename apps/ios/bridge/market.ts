import { ClientError, type ClientCore } from "@ace/client";
import { MarketOperation, type MarketResult } from "@ace/protocol/marketplace";
import { failureSentence, MarketFailure, type MarketStep } from "@ace/ui-core/market";
import { z } from "zod";
import {
  discoverAnswer,
  homeAnswer,
  pictureAnswer,
  publisherAnswer,
  searchAnswer,
  sourcesAnswer,
} from "./market-home.ts";
import { installedAnswer } from "./market-installed.ts";
import { doneAnswer, entryAnswer, reviewAnswer, reviewPageAnswer } from "./market-review.ts";
import { HeldReviews, type HeldRefusal } from "./market-review-held.ts";
import type { MarketWords } from "./market-rows.ts";

/*
 * The phone's marketplace (spec items 1 to 7): every v1 market operation sent to the paired
 * daemon as `marketplace.request`, and its answer handed to Swift with its words written by the
 * shared rules in `@ace/ui-core/market`. Nothing here reaches market.acehq.dev: the daemon does,
 * and search runs on its copy of the index.
 *
 * Each read's last answer is kept for this run, so with the machine unreachable the screen still
 * has what it showed, marked offline; a change is never queued for later.
 */

/** The operations the phone sends in v1: browse, sources, review, install and Installed. */
const v1 = [
  "discover",
  "home",
  "search",
  "read",
  "publisher",
  "picture",
  "sources",
  "addSource",
  "removeSource",
  "setSource",
  "refresh",
  "prepare",
  "prepareUpdate",
  "prepareRollback",
  "readReview",
  "install",
  "cancel",
  "installed",
  "remove",
  "turnOn",
  "turnOnForBots",
] as const satisfies readonly MarketOperation["op"][];
type V1Op = (typeof v1)[number];
const isV1 = (op: string): op is V1Op => (v1 as readonly string[]).includes(op);

export const NativeMarketRequest = z.object({
  type: z.literal("market.native"),
  operation: MarketOperation.refine((operation) => isV1(operation.op), "Not a phone operation"),
  /** Pull to refresh: never answered from the phone's fresh read cache. */
  fresh: z.literal(true).optional(),
});
export type NativeMarketRequest = z.infer<typeof NativeMarketRequest>;

/** The reads whose last answer is kept for the offline screen; pictures are cached by hash. */
const kept = new Set<string>([
  "discover",
  "home",
  "search",
  "read",
  "publisher",
  "sources",
  "installed",
]);

/** What a refusal's button offers (spec item 6). */
export type MarketWay = "retry" | "confirm" | "computer" | "reread" | null;

const stepOf = (op: V1Op): MarketStep => {
  switch (op) {
    case "prepare":
    case "prepareUpdate":
    case "prepareRollback":
    case "readReview":
      return "review";
    case "install":
      return "install";
    case "remove":
      return "remove";
    case "addSource":
      return "add";
    case "removeSource":
      return "removeSource";
    case "setSource":
    case "refresh":
    case "cancel":
    case "turnOn":
    case "turnOnForBots":
      return "change";
    default:
      return "read";
  }
};

function wayOf(code: string): MarketWay {
  switch (code) {
    case "expired":
    case "conflict":
      return "reread";
    case "reauth":
    case "person_grant":
    case "person_only":
      return "confirm";
    case "forbidden":
      return "computer";
    case "unavailable":
    case "busy":
    case "failed":
      return "retry";
    default:
      return null;
  }
}

/** A refusal as the phone shows it: one sentence from its code, and its way out. */
export function refusalAnswer(code: string, step: MarketStep) {
  return {
    ok: false as const,
    offline: false,
    code,
    message: failureSentence(new MarketFailure(code), step),
    way: wayOf(code),
  };
}

/** An install the bridge kept back (`HeldReviews`): the daemon's sentence where it has one. */
function heldRefusal(refusal: HeldRefusal) {
  if (!refusal.message) return refusalAnswer(refusal.code, "install");
  return {
    ok: false as const,
    offline: false,
    code: refusal.code,
    message: refusal.message,
    way: null,
  };
}

const offlineWrite = {
  ok: false as const,
  offline: true,
  code: "offline",
  message: "Your machine is offline. Nothing was changed.",
  way: "retry" as const,
};
const offlineRead = { ...offlineWrite, message: "Your machine is offline." };

/** The daemon's result as the phone's answer, or undefined when it answered something else. */
function shaped(
  operation: MarketOperation,
  result: MarketResult,
  words: MarketWords,
): object | undefined {
  const op = operation.op;
  switch (result.op) {
    case "discover":
      return op === "discover" ? discoverAnswer(result) : undefined;
    case "home":
      return op === "home" ? homeAnswer(result) : undefined;
    case "search":
      return op === "search" ? searchAnswer(result, words) : undefined;
    case "publisher":
      return op === "publisher" ? publisherAnswer(result) : undefined;
    case "picture":
      return op === "picture" ? pictureAnswer(result) : undefined;
    case "sources":
      return ["sources", "addSource", "removeSource", "setSource", "refresh"].includes(op)
        ? sourcesAnswer(result, words)
        : undefined;
    case "read":
      return op === "read" ? entryAnswer(result) : undefined;
    case "review":
      return op.startsWith("prepare") ? reviewAnswer(result) : undefined;
    case "reviewPage":
      return operation.op === "readReview" ? reviewPageAnswer(result, operation.offset) : undefined;
    case "installed":
      return op === "installed" ? installedAnswer(result) : undefined;
    case "done":
      return ["install", "cancel", "remove", "turnOn", "turnOnForBots"].includes(op)
        ? doneAnswer(result)
        : undefined;
    default:
      return undefined;
  }
}

type Owner = Pick<ClientCore, "request">;
/** The SDK's ways of saying the request never reached the machine or never came back. */
const unreachable = new Set<string>(["offline", "stale", "timeout", "not_dispatched"]);
const wait = { timeoutMs: 30_000 };

export class NativeMarket {
  readonly #owner: Owner;
  readonly #now: () => number;
  /** Each kept read's last answer, by its operation. */
  readonly #last = new Map<string, object>();
  /** The reviews open on the machine, which Install is checked against before it is sent. */
  readonly #held = new HeldReviews();
  constructor(owner: Owner, now: () => number) {
    this.#owner = owner;
    this.#now = now;
  }

  async answer(request: NativeMarketRequest, signal: AbortSignal): Promise<object> {
    let { operation } = request;
    if (!isV1(operation.op)) return refusalAnswer("invalid", "read");
    const op = operation.op;
    if (operation.op === "install") {
      const held = this.#held.install(operation);
      if ("refuse" in held) return heldRefusal(held.refuse);
      operation = held.send;
    }
    const key = kept.has(op) ? JSON.stringify(operation) : undefined;
    let result: MarketResult;
    try {
      ({ result } = await this.#owner.request(
        { type: "marketplace.request", operation },
        { ...wait, signal },
      ));
    } catch (error) {
      if (!(error instanceof ClientError) || error.code === "aborted") throw error;
      if (!unreachable.has(error.code)) return refusalAnswer("failed", stepOf(op));
      if (!key)
        return stepOf(op) === "read" || stepOf(op) === "review" ? offlineRead : offlineWrite;
      const last = this.#last.get(key);
      return last ? { ...last, offline: true } : offlineRead;
    }
    this.#held.heard(operation, result);
    if (result.op === "error") return refusalAnswer(result.code, stepOf(op));
    const answer = shaped(operation, result, { now: this.#now() });
    if (!answer) return refusalAnswer("failed", stepOf(op));
    const value = { ok: true, offline: false, ...answer };
    if (key) this.#last.set(key, value);
    return value;
  }
}
