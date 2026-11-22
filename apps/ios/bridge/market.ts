import { ClientError, type ClientCore } from "@ace/client";
import {
  MarketOperation,
  type MarketInstalled,
  type MarketResult,
} from "@ace/protocol/marketplace";
import { LruCache } from "@ace/ui-core";
import {
  failureSentence,
  findingSentences,
  MarketFailure,
  sentence,
  type MarketStep,
} from "@ace/ui-core/market";
import { z } from "zod";
import {
  discoverAnswer,
  homeAnswer,
  pictureAnswer,
  publisherAnswer,
  searchAnswer,
  sourcesAnswer,
} from "./market-home.ts";
import { confirmedAnswer, confirmingRead } from "./market-confirm.ts";
import { installedAnswer } from "./market-installed.ts";
import { doneAnswer, entryAnswer, reviewAnswer, reviewPageAnswer } from "./market-review.ts";
import { HeldReviews, type HeldRefusal } from "./market-review-held.ts";
import type { BrowseWords } from "./market-actions.ts";

/*
 * The phone's marketplace (spec items 1 to 7): every v1 market operation sent to the paired
 * daemon as `marketplace.request`, and its answer handed to Swift with its words written by the
 * shared rules in `@ace/ui-core/market`. Nothing here reaches market.acehq.dev: the daemon does,
 * and search runs on its copy of the index.
 *
 * Each read's last answer is kept for this run, so with the machine unreachable the screen still
 * has what it showed, marked offline; a change is never queued for later. A change whose reply
 * is lost after it was sent may still have happened, so the phone reads what the machine holds
 * before it says whether it did (`market-confirm.ts`).
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

/** Organizations' registries (ADR 0206) wait for a later version on the phone. */
const withoutRegistry = (operation: MarketOperation) =>
  operation.op !== "prepare" ||
  (operation.registry === undefined && operation.trustKey === undefined);

export const NativeMarketRequest = z.object({
  type: z.literal("market.native"),
  operation: MarketOperation.refine(
    (operation) => isV1(operation.op),
    "Not a phone operation",
  ).refine(withoutRegistry, "Registries aren't on the phone yet"),
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
    // ace's checks or this device's scan refused it: the computer shows what was found.
    case "forbidden":
    case "blocked":
    case "refused":
      return "computer";
    case "unavailable":
    case "busy":
    case "failed":
      return "retry";
    default:
      return null;
  }
}

/** What the daemon said about a refusal, for the line under its sentence. */
export interface RefusalDetail {
  /** The operation refused, for words only one operation needs. */
  op?: string;
  /** The daemon's own reason; shown only for `refused`, where it names the check. */
  message?: string;
  /** The scan that refused it, for `blocked`. */
  scan?: Parameters<typeof findingSentences>[0];
}

/** Why, in a line under the sentence: the check that refused it, or the scan's findings. */
function reasonOf(code: string, detail: RefusalDetail): string | undefined {
  if (code === "refused" && detail.message?.trim()) return sentence(detail.message);
  if (code === "blocked") return findingSentences(detail.scan).join(" ") || undefined;
  return undefined;
}

const botsConflict =
  "A newer version of this skill was installed. Look at it again, then turn it on.";

/** A refusal as the phone shows it: one sentence from its code, and its way out. */
export function refusalAnswer(code: string, step: MarketStep, detail: RefusalDetail = {}) {
  const reason = reasonOf(code, detail);
  return {
    ok: false as const,
    offline: false,
    code,
    message:
      detail.op === "turnOnForBots" && code === "conflict"
        ? botsConflict
        : failureSentence(new MarketFailure(code), step),
    way: wayOf(code),
    ...(reason ? { reason } : {}),
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

/** A change sent whose outcome the machine couldn't be asked about: nothing to retry yet. */
const unconfirmed: Readonly<Record<MarketStep, string>> = {
  read: "Couldn't confirm it: your machine stopped answering.",
  review: "Couldn't confirm it: your machine stopped answering.",
  install:
    "Couldn't confirm the install: your machine stopped answering. Check Installed when it's back.",
  remove:
    "Couldn't confirm it was removed: your machine stopped answering. Check Installed when it's back.",
  add: "Couldn't confirm the catalog was added: your machine stopped answering. Check again when it's back.",
  removeSource:
    "Couldn't confirm the catalog was removed: your machine stopped answering. Check again when it's back.",
  publish: "Couldn't confirm it: your machine stopped answering.",
  change:
    "Couldn't confirm the change: your machine stopped answering. Check again when it's back.",
};
const unknownOutcome = (step: MarketStep) => ({
  ok: false as const,
  offline: true,
  code: "unconfirmed",
  message: unconfirmed[step],
  way: "reread" as const,
});

/** The daemon's result as the phone's answer, or undefined when it answered something else. */
function shaped(
  operation: MarketOperation,
  result: MarketResult,
  words: BrowseWords,
): object | undefined {
  const op = operation.op;
  switch (result.op) {
    case "discover":
      return op === "discover" ? discoverAnswer(result, words) : undefined;
    case "home":
      return op === "home" ? homeAnswer(result, words) : undefined;
    case "search":
      return op === "search" ? searchAnswer(result, words) : undefined;
    case "publisher":
      return op === "publisher" ? publisherAnswer(result, words) : undefined;
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

type Owner = Pick<ClientCore, "request" | "state">;
/** The reads whose rows carry a button, so they read what's installed beside them. */
const withRows = new Set<string>(["discover", "home", "search", "publisher"]);

/** A git catalog's address: https, with a host. Anything else never leaves the phone. */
function isCatalogAddress(address: string): boolean {
  if (!URL.canParse(address)) return false;
  const url = new URL(address);
  return url.protocol === "https:" && url.hostname.length > 0;
}
/** The SDK's ways of saying the request never reached the machine or never came back. */
const unreachable = new Set<string>(["offline", "stale", "timeout", "not_dispatched"]);
const wait = { timeoutMs: 30_000 };
/** How a lost change is checked: a few reads, a moment apart, for a daemon still finishing it. */
const checks = 3;
const checkWait = { timeoutMs: 10_000 };
const checkPause = 2_000;
/** At most this many reads' last answers are kept for the offline screen. */
const keptAnswers = 32;
const pauseFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export class NativeMarket {
  readonly #owner: Owner;
  readonly #now: () => number;
  readonly #pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Each kept read's last answer, by its operation, the least recently used let go first. */
  readonly #last = new LruCache<string, object>({ maxEntries: keptAnswers });
  /** The reviews open on the machine, which Install is checked against before it is sent. */
  readonly #held = new HeldReviews();
  readonly #botName: (id: string) => string | undefined;
  constructor(
    owner: Owner,
    now: () => number,
    pause: (ms: number, signal: AbortSignal) => Promise<void> = pauseFor,
    botName: (id: string) => string | undefined = () => undefined,
  ) {
    this.#owner = owner;
    this.#now = now;
    this.#pause = pause;
    this.#botName = botName;
  }

  /** Whether the machine no longer holds review `id`: reading it answers expired or not found. */
  async #swept(id: string, signal: AbortSignal): Promise<boolean> {
    const probe: MarketOperation = { op: "readReview", id, offset: 0 };
    try {
      const { result } = await this.#owner.request(
        { type: "marketplace.request", operation: probe },
        { ...wait, signal },
      );
      this.#held.heard(probe, result);
      return result.op === "error" && (result.code === "expired" || result.code === "not_found");
    } catch {
      return false;
    }
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
    const step = stepOf(op);
    const changes = step !== "read" && step !== "review";
    if (operation.op === "addSource" && !isCatalogAddress(operation.address))
      return refusalAnswer("invalid", "add");
    // Not connected: the request can't leave the phone, so nothing was changed.
    if (this.#owner.state !== "ready") return changes ? offlineWrite : this.#offline(key);
    const installed = withRows.has(op) ? this.#readInstalled(signal) : undefined;
    let result: MarketResult;
    try {
      ({ result } = await this.#owner.request(
        { type: "marketplace.request", operation },
        { ...wait, signal },
      ));
    } catch (error) {
      if (!(error instanceof ClientError) || error.code === "aborted") throw error;
      if (!unreachable.has(error.code)) return refusalAnswer("failed", step);
      // Sent, then the reply was lost: the change may have happened. Ask what's there now.
      if (changes) {
        const outcome = await this.#confirm(operation, step, signal);
        // An install found landed is done: its review is no longer held.
        if (outcome.ok && operation.op === "install") this.#held.heard(operation, { op: "done" });
        return outcome;
      }
      return this.#offline(key);
    }
    this.#held.heard(operation, result);
    if (
      result.op === "error" &&
      operation.op === "install" &&
      wayOf(result.code) === "confirm" &&
      (await this.#swept(operation.id, signal))
    )
      // The standing gate answered before the review was looked up, and the review is gone:
      // the way out is to review it again, not to confirm who installs a review nobody holds.
      return refusalAnswer("expired", "install");
    if (result.op === "error")
      return refusalAnswer(result.code, step, {
        op,
        message: result.message,
        ...(result.scan ? { scan: result.scan } : {}),
      });
    const answer = shaped(operation, result, {
      now: this.#now(),
      installed: installed ? await installed : undefined,
      botName: this.#botName,
    });
    if (!answer) return refusalAnswer("failed", stepOf(op));
    const value = { ok: true, offline: false, ...answer };
    if (key) this.#last.set(key, value);
    return value;
  }

  /**
   * What's installed, read beside a browse read so its rows' buttons are right. Undefined when
   * it can't be read: an older list could offer Get for what is installed now. Never throws.
   */
  async #readInstalled(signal: AbortSignal): Promise<readonly MarketInstalled[] | undefined> {
    try {
      const { result } = await this.#owner.request(
        { type: "marketplace.request", operation: { op: "installed" } },
        { ...wait, signal },
      );
      return result.op === "installed" ? result.installed : undefined;
    } catch {
      return undefined;
    }
  }

  #offline(key: string | undefined): object {
    const last = key ? this.#last.get(key) : undefined;
    return last ? { ...last, offline: true } : offlineRead;
  }

  /** A change's outcome, from what the machine holds after its reply was lost. */
  async #confirm(operation: MarketOperation, step: MarketStep, signal: AbortSignal) {
    const read = confirmingRead(operation);
    // A review let go is gone either way; its reply is not worth asking after.
    if (!read) return { ok: true, offline: false, installed: null };
    for (let check = 0; check < checks; check++) {
      if (check) await this.#pause(checkPause, signal);
      if (signal.aborted) break;
      let result: MarketResult;
      try {
        ({ result } = await this.#owner.request(
          { type: "marketplace.request", operation: read },
          { ...checkWait, signal },
        ));
      } catch {
        return unknownOutcome(step);
      }
      if (result.op === "error") return unknownOutcome(step);
      const landed = confirmedAnswer(operation, result, { now: this.#now() });
      if (landed) return { ok: true, offline: false, ...landed };
    }
    // Read a few times and still not there: it didn't happen, and trying again is safe.
    return signal.aborted ? unknownOutcome(step) : refusalAnswer("failed", step);
  }
}
