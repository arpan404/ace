import type { MarketReview, MarketReviewItem } from "@ace/protocol/marketplace";
import { SuitManifest, type SuitDetail } from "@ace/protocol/suits";
import { parseStoredBotFace, type BotFace } from "@ace/ui-core/bot-face";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { reviewKey, type EntryKey, type PreparedReview } from "./market-api.ts";

/*
 * What an entry looks like, from what this machine already knows: a Suit's palette from the Suit
 * library when it is installed (or built in), else from its review once one was prepared; a
 * bot's face from its review. Nothing is fetched for a card: a listing without a picture of its
 * own shows its type's mark until the market's listings carry previews (ADR 0174).
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
  let raw: unknown;
  try {
    raw = JSON.parse(text.text);
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
      contentHash: review.hash,
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

/** What a Suit entry looks like: installed, it is the library's; else its review's, if held. */
export function useSuitLook(key: EntryKey, installedAs?: string): SuitDetail | undefined {
  const installed = useLibrarySuit(key.type === "suit" ? (installedAs ?? key.name) : undefined);
  const held = useHeldReview(key);
  return installed ?? (held ? suitFromReview(held.review, held.items) : undefined);
}

/** A bot entry's face, once its review is held. */
export function useBotLook(key: EntryKey): BotFace | undefined {
  return faceFromReview(useHeldReview(key)?.review);
}
