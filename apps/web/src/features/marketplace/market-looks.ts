import type { MarketReview, MarketReviewItem } from "@ace/protocol/marketplace";
import { SuitManifest, type SuitDetail } from "@ace/protocol/suits";
import { parseStoredBotFace, type BotFace } from "@ace/ui-core/bot-face";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import {
  reviewKey,
  useMarketLook,
  useMarketReview,
  type EntryKey,
  type PreparedReview,
  type VersionedKey,
} from "./market-api.ts";

/*
 * What an entry looks like, from what this machine already knows: a Suit's palette from the Suit
 * library when it is installed (or built in), else from a review already prepared, else from the
 * daemon's `look` of its listed version; a bot's face the same way. A card never prepares a
 * review: that waits behind installs, so a shelf of faces would arrive one by one. Only a daemon
 * without `look` falls back to preparing one.
 */

/** The Suit's `suit.json` from its review, as the library would read it; undefined if it isn't one. */
export function suitFromReview(
  review: MarketReview,
  items: readonly MarketReviewItem[],
): SuitDetail | undefined {
  const text = items.find(
    (item) => item.kind === "text" && item.path === "suit.json" && !item.before,
  );
  if (text?.kind !== "text" || review.type !== "suit") return undefined;
  return suitFromJson(text.text, review.hash);
}

/** A Suit's `suit.json` text as the library would read it; undefined if it isn't one. */
export function suitFromJson(text: string, contentHash: string): SuitDetail | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const manifest = SuitManifest.safeParse(raw);
  if (!manifest.success) return undefined;
  return {
    summary: {
      id: manifest.data.id,
      name: manifest.data.name,
      description: manifest.data.description,
      schemes: [manifest.data.light && "light", manifest.data.dark && "dark"].filter(
        (scheme): scheme is "light" | "dark" => !!scheme,
      ),
      scene: false,
      contentHash,
      problems: [],
    },
    manifest: manifest.data,
    sceneUrl: null,
    sceneUrls: {},
    assets: {},
    css: null,
    ornaments: {},
  };
}

/** A bot recipe's face from its review, repaired the way Spade repairs a stored face. */
export function faceFromReview(review: MarketReview | undefined): BotFace | undefined {
  return review?.body.type === "spade-bot" ? parseStoredBotFace(review.body.face)?.face : undefined;
}

/** The entry's prepared install review, if one is in the cache; never prepares one. */
export function useHeldReview(key: EntryKey): PreparedReview | undefined {
  return useQuery<PreparedReview>({
    queryKey: reviewKey(key, false),
    queryFn: skipToken,
    staleTime: Infinity,
  }).data;
}

/** The installed Suit named `id` in the library, read when first asked for. */
export function useLibrarySuit(id: string | undefined): SuitDetail | undefined {
  const library = useSuitLibrary();
  const summary = id ? library.summaries?.find((suit) => suit.id === id) : undefined;
  const { want } = library;
  useEffect(() => {
    if (summary) want(summary);
  }, [want, summary]);
  return summary ? library.detail(summary) : undefined;
}

/**
 * An entry's look for a card: the review already held (its page prepared one), else the daemon's
 * `look`. A daemon too old to answer `look` prepares the review, as before it had one.
 */
function useLook(key: VersionedKey, enabled: boolean) {
  const held = useHeldReview(key);
  const look = useMarketLook(key, enabled && held === undefined);
  const prepared = useMarketReview(key, { update: false, enabled: enabled && look.isError }).data;
  return { review: held ?? prepared, look: look.data };
}

/** What a Suit entry looks like: installed, it is the library's; else its review's or look's. */
export function useSuitLook(key: VersionedKey, installedAs?: string): SuitDetail | undefined {
  const installed = useLibrarySuit(key.type === "suit" ? (installedAs ?? key.name) : undefined);
  const { review, look } = useLook(key, key.type === "suit" && installed === undefined);
  if (installed) return installed;
  if (review) return suitFromReview(review.review, review.items);
  return look?.suit ? suitFromJson(look.suit, `${key.name}@${key.version ?? ""}`) : undefined;
}

/** A bot entry's face: its held review's, else its look's. Undefined while it loads or has none. */
export function useBotLook(key: VersionedKey): BotFace | undefined {
  const { review, look } = useLook(key, key.type === "spade-bot");
  if (review) return faceFromReview(review.review);
  return look?.face ? parseStoredBotFace(look.face)?.face : undefined;
}

/**
 * Whether this machine's Suit library already holds a Suit with this id: built into ace, made
 * here or installed before. The library refuses a second Suit with the same id.
 */
export function useInLibrary(type: string, id: string): boolean {
  const summaries = useSuitLibrary().summaries;
  return type === "suit" && (summaries?.some((suit) => suit.id === id) ?? false);
}
