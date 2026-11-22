import type { MarketResult } from "@ace/protocol/marketplace";
import type { PreparedEntry } from "./review.ts";

/*
 * What a listed Suit or bot looks like on its card: a bot's face, a Suit's `suit.json`. Read from
 * the version's checked bytes, as a review reads them, but without opening a review or waiting
 * behind installs: a page of cards asks for many at once. A few fetches run together, one per
 * entry however many cards ask, and each version's look is kept, so a card drawn again costs
 * nothing. The newest version's (no version named) is kept for as long as a review is.
 */

export type Look = Extract<MarketResult, { op: "look" }>;

export interface LookRequest {
  source: string;
  type: string;
  name: string;
  version?: string | undefined;
}

export interface LookPorts {
  /** The version's bytes, fetched and checked as a review checks them; throws when refused. */
  fetch(request: LookRequest): Promise<PreparedEntry>;
  now(): number;
}

/** The types that have a look; any other type's is empty. */
const lookTypes: ReadonlySet<string> = new Set(["spade-bot", "suit"]);
const decoder = new TextDecoder();
const maxSuitChars = 256_000;
const latestLifetimeMs = 30 * 60_000;
const maxHeld = 512;
const maxFetching = 4;

/** The look in a checked version: its face, or its `suit.json`. */
export function lookOf(entry: PreparedEntry): Look {
  const inspection = entry.checked.inspection;
  if (inspection?.type === "spade-bot")
    return inspection.recipe.face ? { op: "look", face: inspection.recipe.face } : { op: "look" };
  if (inspection?.type === "suit") {
    const file = entry.checked.files.find((item) => item.path === "suit.json");
    const text = file ? decoder.decode(file.content) : undefined;
    return text && text.length <= maxSuitChars ? { op: "look", suit: text } : { op: "look" };
  }
  return { op: "look" };
}

interface Held {
  look: Look;
  /** When a newest-version look stops being used; a named version's never does. */
  until: number | undefined;
}

export class EntryLooks {
  readonly #ports: LookPorts;
  /** Oldest first; a hit moves to the end. */
  readonly #held = new Map<string, Held>();
  readonly #fetching = new Map<string, Promise<Look>>();
  readonly #waiting: (() => void)[] = [];
  #running = 0;

  constructor(ports: LookPorts) {
    this.#ports = ports;
  }

  async read(request: LookRequest): Promise<Look> {
    if (!lookTypes.has(request.type)) return { op: "look" };
    const key = `${request.source}\n${request.type}\n${request.name}\n${request.version ?? ""}`;
    const held = this.#held.get(key);
    if (held && (held.until === undefined || held.until > this.#ports.now())) {
      this.#held.delete(key);
      this.#held.set(key, held);
      return held.look;
    }
    const fetching = this.#fetching.get(key);
    if (fetching) return fetching;
    const next = this.#fetch(key, request).finally(() => this.#fetching.delete(key));
    this.#fetching.set(key, next);
    return next;
  }

  async #fetch(key: string, request: LookRequest): Promise<Look> {
    await this.#turn();
    try {
      const look = lookOf(await this.#ports.fetch(request));
      const until = request.version ? undefined : this.#ports.now() + latestLifetimeMs;
      this.#held.delete(key);
      this.#held.set(key, { look, until });
      for (const old of this.#held.keys()) {
        if (this.#held.size <= maxHeld) break;
        this.#held.delete(old);
      }
      return look;
    } finally {
      // The slot passes straight to the next waiting fetch, so none slips in between.
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running--;
    }
  }

  /** Takes one of `maxFetching` slots, waiting for one to be handed over when all are taken. */
  async #turn(): Promise<void> {
    if (this.#running < maxFetching) {
      this.#running++;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }
}
