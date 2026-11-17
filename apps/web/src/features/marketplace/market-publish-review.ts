import type {
  MarketDraftCheck,
  MarketDraftChecked,
  MarketDraftSource,
  MarketPickType,
  MarketPrivacySpan,
} from "@ace/protocol/marketplace";
import { useEffect } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { market, marketKey } from "./market-api.ts";
import { MarketFailure } from "./market-model.ts";

/*
 * What a draft would upload, as the daemon checks it on this machine before anything leaves
 * (ADR 0174 §2), and the privacy pass over text the person edits. The daemon owns both; the app
 * shows them and sends back what the person confirmed.
 */

const reviewKey = [...marketKey, "publish", "review"] as const;

/** The daemon's check of what publishing `source` as `type/name` would upload. */
export function useDraftCheck(type: MarketPickType, name: string, source: MarketDraftSource) {
  return useDaemonQuery<MarketDraftCheck>({
    queryKey: [...reviewKey, "check", type, name, JSON.stringify(source)],
    retry: false,
    staleTime: 0,
    gcTime: 0,
    read: async (client, signal) => {
      const { answer } = await market(
        client,
        { op: "publish", request: { action: "draftCheck", type, name, source } },
        "publish",
        signal,
      );
      if (answer.kind !== "checked") throw new MarketFailure("failed");
      return answer.check;
    },
  });
}

/** The privacy pass over `texts`, in order; undefined until it answers for these texts. */
export function usePrivacy(texts: readonly string[]): readonly MarketPrivacySpan[][] | undefined {
  return useDaemonQuery({
    queryKey: [...reviewKey, "privacy", ...texts],
    retry: false,
    read: async (client, signal) =>
      (await market(client, { op: "privacyCheck", texts: [...texts] }, "privacyCheck", signal))
        .spans,
  }).data;
}

/** The daemon's words for why something failed, else ours. */
export const failedWords = (error: unknown, fallback: string) =>
  error instanceof MarketFailure && error.detail ? error.detail : fallback;

/** Each flagged text once, in order, leaving out secrets (never confirmable). */
export function acceptedTexts(spans: readonly (readonly MarketPrivacySpan[])[]): string[] {
  const texts: string[] = [];
  for (const list of spans)
    for (const span of list)
      if (span.kind !== "secret" && !texts.includes(span.text)) texts.push(span.text);
  return texts;
}

/** "2048" → "2 KB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Tells `report` the person's confirmation after each render; the parent keeps it only when it changed. */
export function useReport(
  checked: MarketDraftChecked | undefined,
  report: (checked: MarketDraftChecked | undefined) => void,
) {
  useEffect(() => {
    report(checked);
  }, [checked, report]);
}
