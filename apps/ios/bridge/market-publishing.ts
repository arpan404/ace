import { ClientError, type ClientCore } from "@ace/client";
import {
  MarketCategoryId,
  MarketDisplayName,
  MarketDraftId,
  MarketDraftSource,
  MarketEntryName,
  MarketEntryType,
  MarketHandle,
  MarketLink,
  MarketPickType,
  MarketVersion,
  type MarketDraft,
  type MarketDraftCheck,
  type MarketMe,
  type MarketOperation,
  type MarketPublishAction,
  type MarketPublishAnswer,
  type MarketResult,
} from "@ace/protocol/marketplace";
import { LruCache } from "@ace/ui-core";
import { z } from "zod";
import { refusalAnswer } from "./market.ts";
import { personRefusal, type SocketStanding } from "./market-person.ts";
import {
  checkAnswer,
  confirmationOf,
  draftAnswer,
  manageAnswer,
  meAnswer,
  pickRow,
  profileRow,
} from "./market-publish-words.ts";

/*
 * Publishing and managing from the phone (#2548, #2554): each screen's step as one
 * `market.publish` request, which the bridge turns into the daemon's `publish` actions. A step
 * that takes several (a draft made, then read until ace's scan is done; a version published,
 * then its listing and pictures) runs here, so Swift sends one request and draws one answer.
 *
 * Nothing about a draft's files leaves the phone's say-so: the phone confirms the check it was
 * shown by its hash, and the bridge builds the confirmation from the check it holds for that
 * hash, so the person can only confirm what they saw. A change whose reply is lost is never
 * said to have failed: the phone says it couldn't confirm it.
 */

const Pick = z.string().max(4096);
const PictureData = z.string().min(1).max(1_400_000);
const Listing = z.strictObject({
  title: z.string().trim().min(1).max(120),
  line: z.string().trim().max(300),
  description: z.string().max(8192),
  categories: z.array(MarketCategoryId).max(3),
});
const entry = { type: MarketPickType, name: MarketEntryName };
/** One of the publisher's own listings, of any type (a Suit published from the computer too). */
const ownEntry = { type: MarketEntryType, name: MarketEntryName };

export const NativePublishRequest = z.object({
  type: z.literal("market.publish"),
  /** Confirm it's you: the person's one retry of a step refused for standing. */
  confirmed: z.literal(true).optional(),
  step: z.discriminatedUnion("step", [
    z.strictObject({ step: z.literal("me") }),
    z.strictObject({ step: z.literal("pick"), type: MarketPickType }),
    z.strictObject({ step: z.literal("check"), ...entry, pick: Pick }),
    z.strictObject({
      step: z.literal("draft"),
      ...entry,
      pick: Pick,
      version: MarketVersion,
      /** The hash of the check the person confirmed. */
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      binaries: z.array(z.string().max(512)).max(1024).default([]),
      /** A bot's routines the person kept, by index; absent keeps them all. */
      routines: z.array(z.number().int().min(0).max(31)).max(32).optional(),
      /** A draft of it already made, whose files are sent again. */
      draft: MarketDraftId.optional(),
    }),
    z.strictObject({
      step: z.literal("submit"),
      draft: MarketDraftId,
      version: MarketVersion,
      notes: z.string().max(4000).default(""),
      listing: Listing,
      pictures: z.array(PictureData).max(4).default([]),
    }),
    z.strictObject({ step: z.literal("listing"), ...ownEntry }),
    z.strictObject({
      step: z.literal("withdraw"),
      ...ownEntry,
      /** Absent withdraws the whole listing. */
      version: MarketVersion.optional(),
      reason: z.string().trim().min(1).max(500),
    }),
    z.strictObject({
      step: z.literal("createProfile"),
      handle: MarketHandle,
      name: MarketDisplayName,
      bio: z.string().max(500).default(""),
    }),
    z.strictObject({
      step: z.literal("profile"),
      name: MarketDisplayName,
      bio: z.string().max(500),
      links: z.array(MarketLink).max(5),
    }),
    z.strictObject({ step: z.literal("handle"), handle: MarketHandle }),
    z.strictObject({ step: z.literal("avatar"), image: PictureData }),
  ]),
});
export type NativePublishRequest = z.infer<typeof NativePublishRequest>;
type Step = NativePublishRequest["step"];
type CheckedPick = Pick<Extract<Step, { step: "check" }>, "type" | "name" | "pick">;

const checkKey = ({ type, name, pick }: CheckedPick, hash: string) =>
  JSON.stringify([type, name, pick, hash]);

/** The steps that only read; the rest change the publisher's market. */
const reads = new Set<Step["step"]>(["me", "pick", "check", "listing"]);
const unreachable = new Set<string>(["offline", "stale", "timeout", "not_dispatched"]);
const wait = { timeoutMs: 30_000 };
/** A draft's scan is read again this often, this many times, before the phone is told it waits. */
const scanPause = 1_500;
const scanReads = 40;
/** Checks the person may still confirm, by pick, listing and hash. */
const heldChecks = 16;

const offline = (changes: boolean) => ({
  ok: false as const,
  offline: true,
  code: "offline",
  message: changes ? "Your machine is offline. Nothing was changed." : "Your machine is offline.",
  way: "retry" as const,
});
const unconfirmed = {
  ok: false as const,
  offline: true,
  code: "unconfirmed",
  message:
    "Couldn't confirm it: your machine stopped answering. Check your listings when it's back.",
  way: "reread" as const,
};
const lookAgain = {
  ok: false as const,
  offline: false,
  code: "expired",
  message: "Look at what it uploads again, then confirm it.",
  way: "reread" as const,
};

/** A daemon refusal of a step, kept apart from the answers it shapes. */
class Refusal {
  readonly result: Extract<MarketResult, { op: "error" }>;
  constructor(result: Extract<MarketResult, { op: "error" }>) {
    this.result = result;
  }
}
/** The check the person confirmed isn't one this bridge holds: it restarted, or it's old. */
const unheld = new Refusal({ op: "error", code: "expired", message: "" });
const failed = (message = "The machine answered something this build doesn't read") =>
  new Refusal({ op: "error", code: "failed", message });

type Owner = Pick<ClientCore, "request" | "state">;
type Kind = MarketPublishAnswer["kind"];

export class NativePublish {
  readonly #owner: Owner;
  readonly #pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #standing: () => SocketStanding;
  readonly #checks = new LruCache<string, MarketDraftCheck>({
    maxEntries: heldChecks,
  });

  constructor(
    owner: Owner,
    pause: (ms: number, signal: AbortSignal) => Promise<void>,
    standing: () => SocketStanding = () => ({ state: undefined, route: "paired" }),
  ) {
    this.#owner = owner;
    this.#pause = pause;
    this.#standing = standing;
  }

  async answer(request: NativePublishRequest, signal: AbortSignal): Promise<object> {
    const { step } = request;
    const changes = !reads.has(step.step);
    if (this.#owner.state !== "ready") return offline(changes);
    try {
      return { ok: true, offline: false, ...(await this.#run(step, signal)) };
    } catch (error) {
      if (error instanceof Refusal) {
        const { result } = error;
        if (error === unheld) return lookAgain;
        return personRefusal(
          refusalAnswer(result.code, "publish", {
            op: "publish",
            message: result.message,
            ...(result.scan ? { scan: result.scan } : {}),
          }),
          { op: "publish", standing: this.#standing(), confirmed: request.confirmed === true },
        );
      }
      if (!(error instanceof ClientError) || error.code === "aborted") throw error;
      if (!unreachable.has(error.code)) return refusalAnswer("failed", "publish");
      return changes ? unconfirmed : offline(false);
    }
  }

  async #send(operation: MarketOperation, signal: AbortSignal): Promise<MarketResult> {
    const { result } = await this.#owner.request(
      { type: "marketplace.request", operation },
      { ...wait, signal },
    );
    if (result.op === "error") throw new Refusal(result);
    return result;
  }

  async #publish<K extends Kind>(
    action: MarketPublishAction,
    kind: K,
    signal: AbortSignal,
  ): Promise<Extract<MarketPublishAnswer, { kind: K }>> {
    const result = await this.#send({ op: "publish", request: action }, signal);
    if (result.op !== "publish" || result.answer.kind !== kind) throw failed();
    return result.answer as Extract<MarketPublishAnswer, { kind: K }>;
  }

  /** The publisher's page, or undefined when it can't be read (signed out, say). */
  async #me(signal: AbortSignal): Promise<MarketMe | undefined> {
    try {
      return (await this.#publish({ action: "me" }, "me", signal)).me;
    } catch (error) {
      if (error instanceof Refusal) return undefined;
      throw error;
    }
  }

  async #run(step: Step, signal: AbortSignal): Promise<object> {
    switch (step.step) {
      case "me":
        return meAnswer((await this.#publish({ action: "me" }, "me", signal)).me);
      case "pick": {
        const me = this.#me(signal);
        const result = await this.#send({ op: "publishables", type: step.type }, signal);
        if (result.op !== "publishables") throw failed();
        const page = await me;
        return {
          items: result.items.map((item) => pickRow(item, page)),
          unavailable: result.unavailable,
        };
      }
      case "check": {
        const source = sourceOf(step.pick);
        const { check } = await this.#publish(
          { action: "draftCheck", type: step.type, name: step.name, source },
          "checked",
          signal,
        );
        this.#checks.set(checkKey(step, check.hash), check);
        return checkAnswer(check);
      }
      case "draft":
        return draftAnswer(await this.#draft(step, signal));
      case "submit":
        return await this.#submit(step, signal);
      case "listing":
        return await this.#listing(step.type, step.name, signal);
      case "withdraw": {
        await this.#send(
          {
            op: "publish",
            request: {
              action: "withdraw",
              type: step.type,
              name: step.name,
              ...(step.version ? { version: step.version } : {}),
              reason: step.reason,
            },
          },
          signal,
        );
        const message = step.version
          ? `${step.version} is withdrawn. Anyone who installed it sees that it was withdrawn.`
          : "The listing is withdrawn. Anyone who installed it sees that it was withdrawn.";
        try {
          return { message, ...(await this.#listing(step.type, step.name, signal)) };
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          return { message };
        }
      }
      case "createProfile": {
        const { profile } = await this.#publish(
          {
            action: "createProfile",
            profile: { handle: step.handle, displayName: step.name, bio: step.bio, links: [] },
          },
          "profile",
          signal,
        );
        return { profile: profileRow(profile) };
      }
      case "profile": {
        const { profile } = await this.#publish(
          {
            action: "editProfile",
            profile: { displayName: step.name, bio: step.bio, links: step.links },
          },
          "profile",
          signal,
        );
        return { profile: profileRow(profile) };
      }
      case "handle": {
        const action = { action: "changeHandle", handle: step.handle } as const;
        return { profile: profileRow((await this.#publish(action, "profile", signal)).profile) };
      }
      case "avatar": {
        const action = { action: "setAvatar", image: step.image } as const;
        return { profile: profileRow((await this.#publish(action, "profile", signal)).profile) };
      }
    }
  }

  /** The draft made from the confirmed check, read until ace's scan is done or long enough. */
  async #draft(step: Extract<Step, { step: "draft" }>, signal: AbortSignal): Promise<MarketDraft> {
    const held = this.#checks.get(checkKey(step, step.hash));
    if (!held) throw unheld;
    const source = sourceOf(step.pick);
    const checked = confirmationOf(held, step.binaries, step.routines);
    const made = step.draft
      ? await this.#publish(
          { action: "draftUpdate", id: step.draft, version: step.version, source, checked },
          "draft",
          signal,
        )
      : await this.#publish(
          {
            action: "draftCreate",
            type: step.type,
            name: step.name,
            version: step.version,
            source,
            checked,
          },
          "draft",
          signal,
        );
    let { draft } = made;
    for (let read = 0; draft.scan.state === "scanning" && read < scanReads; read++) {
      if (read > 0) await this.#pause(scanPause, signal);
      if (signal.aborted) break;
      draft = (await this.#publish({ action: "draftRead", id: draft.id }, "draft", signal)).draft;
    }
    return draft;
  }

  /**
   * Publishes the draft at the listing's version, then writes its listing and pictures. Once
   * the version is in, a listing the market won't take doesn't undo it: the answer says so.
   */
  async #submit(step: Extract<Step, { step: "submit" }>, signal: AbortSignal) {
    await this.#publish(
      { action: "draftUpdate", id: step.draft, version: step.version, changelog: step.notes },
      "draft",
      signal,
    );
    const published = await this.#publish(
      { action: "draftPublish", id: step.draft },
      "published",
      signal,
    );
    const { type, name } = published;
    let listingProblem: string | null = null;
    try {
      const own = await this.#publish({ action: "entry", type, name }, "entry", signal);
      await this.#send(
        {
          op: "publish",
          request: {
            action: "listing",
            type,
            name,
            listing: {
              ...own.entry.listing,
              title: step.listing.title,
              line: step.listing.line,
              description: step.listing.description,
              categories: step.listing.categories,
            },
          },
        },
        signal,
      );
      for (const [index, image] of step.pictures.entries())
        await this.#send(
          { op: "publish", request: { action: "preview", type, name, index, image } },
          signal,
        );
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      listingProblem = `${step.version} is in, but its listing wasn't saved: ${refusalAnswer(error.result.code, "publish").message}`;
    }
    return {
      published: {
        type,
        name,
        version: published.version,
        held: published.held,
        title: `${step.listing.title} is waiting for review`,
        line: published.held
          ? "A maintainer looks at it first, then it's listed once ace signs it."
          : "It's listed as soon as ace signs it.",
        listingProblem,
      },
    };
  }

  async #listing(type: MarketEntryType, name: string, signal: AbortSignal) {
    const { entry: own } = await this.#publish({ action: "entry", type, name }, "entry", signal);
    let signals;
    try {
      signals = (await this.#publish({ action: "signals", type, name }, "signals", signal)).signals;
    } catch (error) {
      // An entry with no signals yet still shows its versions.
      if (!(error instanceof Refusal)) throw error;
    }
    return manageAnswer(own, signals);
  }
}

const picked = new Set<string>(["spade-bot", "spade-skill", "ace-skill", "plugin"]);

/** A picked thing's source, from the id the phone sent back; a malformed one is refused. */
function sourceOf(pick: string): MarketDraftSource {
  let raw: unknown;
  try {
    raw = JSON.parse(pick);
  } catch {
    throw new Refusal({ op: "error", code: "invalid", message: "" });
  }
  const parsed = MarketDraftSource.safeParse(raw);
  // Only what the picker offers: never a path, an archive or a Suit from the phone.
  if (!parsed.success || !picked.has(parsed.data.kind))
    throw new Refusal({ op: "error", code: "invalid", message: "" });
  return parsed.data;
}
