import {
  tierOf,
  verifyBlocklist,
  verifyNotices,
  verifyOfficialList,
  verifyVerifiedList,
  type RankingTier,
} from "@ace/marketplace";
import type {
  MarketBlocklist,
  MarketKeySet,
  MarketNotices,
  MarketOfficialList,
  MarketVerificationProof,
  MarketVerifiedList,
} from "@ace/protocol/marketplace";
import type { MarketHttp } from "./http.ts";
import type { MarketStore } from "./store.ts";

/*
 * The market's signed lists beside the withdrawn one (ADR 0174 §8, §13, §14): the blocklist, the
 * verified publishers and the official publisher. Each is kept as it was signed and verified
 * against the keys this build ships whenever it is read, so neither the Worker nor a changed
 * file on disk can grant a mark; the newest issued list a device verified wins. "Verified" and
 * "By ace" on this device come only from here, never from the index's display flags.
 */

export interface TrustLists {
  blocklist?: MarketBlocklist | undefined;
  verified?: MarketVerifiedList | undefined;
  official?: MarketOfficialList | undefined;
  notices?: MarketNotices | undefined;
}

const lists = {
  blocklist: { meta: "signed-blocklist", verify: verifyBlocklist },
  verified: { meta: "signed-verified", verify: verifyVerifiedList },
  official: { meta: "signed-official", verify: verifyOfficialList },
  notices: { meta: "signed-notices", verify: verifyNotices },
} as const;
type ListName = keyof typeof lists;

/** `signed` verified with `verify`, or undefined when no key this build ships signed it. */
function verifiedWith<T>(
  verify: (signed: unknown, keys: MarketKeySet) => T,
  signed: unknown,
  keys: MarketKeySet,
): T | undefined {
  try {
    return verify(signed, keys);
  } catch {
    return undefined;
  }
}

function parsed(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The lists a store holds, each verified again; cached until a list changes. */
export class Trust {
  readonly #store: MarketStore;
  readonly #keys: MarketKeySet;
  #cached: TrustLists | undefined;

  constructor(store: MarketStore, keys: MarketKeySet) {
    this.#store = store;
    this.#keys = keys;
  }

  current(): TrustLists {
    if (this.#cached) return this.#cached;
    const read = <T>(list: {
      meta: string;
      verify: (signed: unknown, keys: MarketKeySet) => T;
    }) => {
      const signed = parsed(this.#store.meta(list.meta));
      return signed === undefined ? undefined : verifiedWith(list.verify, signed, this.#keys);
    };
    this.#cached = {
      blocklist: read(lists.blocklist),
      verified: read(lists.verified),
      official: read(lists.official),
      notices: read(lists.notices),
    };
    return this.#cached;
  }

  /**
   * Reads each list from the market and keeps it when it verifies and is newer than the one
   * held. Answers whether the blocklist changed, so installed bytes are checked against it.
   */
  async learn(http: MarketHttp | undefined): Promise<{ blocklist: boolean }> {
    if (!http) return { blocklist: false };
    const blocklist = await this.#learnOne(lists.blocklist, http.blocklist, "blocklist");
    await this.#learnOne(lists.verified, http.verified, "verified");
    await this.#learnOne(lists.official, http.official, "official");
    await this.#learnOne(lists.notices, http.notices, "notices");
    return { blocklist };
  }

  /**
   * The terms notices as signed, for Spade, which checks the signature again with the keys its
   * own build ships; undefined unless they verify here.
   */
  signedNotices(): unknown {
    return this.current().notices ? parsed(this.#store.meta(lists.notices.meta)) : undefined;
  }

  async #learnOne<T extends { issued: number }>(
    list: { meta: string; verify: (signed: unknown, keys: MarketKeySet) => T },
    read: () => Promise<unknown>,
    name: ListName,
  ): Promise<boolean> {
    const signed = await read().catch(() => undefined);
    if (signed === undefined) return false;
    const next = verifiedWith(list.verify, signed, this.#keys);
    if (!next) return false;
    const held = this.current()[name];
    if (held && held.issued >= next.issued) return false;
    this.#store.setMeta(list.meta, JSON.stringify(signed));
    this.#cached = undefined;
    return true;
  }
}

/** What a publisher id earns on this device, from verified lists only. */
export interface Badges {
  verified(publisherId: string | undefined): boolean;
  verifiedHandle(handle: string): boolean;
  official(publisherId: string | undefined): boolean;
  officialHandle(handle: string): boolean;
  proofs(publisherId: string | undefined): MarketVerificationProof[];
  tier(publisherId: string | undefined): RankingTier;
}

export function badgesOf(trust: TrustLists): Badges {
  const verifiedIds = new Map(
    (trust.verified?.publishers ?? []).map((publisher) => [publisher.id, publisher.proofs]),
  );
  const verifiedHandles = new Set(
    (trust.verified?.publishers ?? []).map((publisher) => publisher.handle),
  );
  const officialId = trust.official?.publisher.id;
  const officialHandle = trust.official?.publisher.name;
  const badges: Badges = {
    verified: (id) => id !== undefined && verifiedIds.has(id),
    verifiedHandle: (handle) => verifiedHandles.has(handle),
    official: (id) => id !== undefined && officialId !== undefined && id === officialId,
    officialHandle: (handle) => handle === officialHandle,
    proofs: (id) => (id === undefined ? [] : (verifiedIds.get(id) ?? [])),
    tier: (id) => tierOf({ official: badges.official(id), verified: badges.verified(id) }),
  };
  return badges;
}

/** No lists: nobody is verified or official. */
export const noBadges: Badges = badgesOf({});
