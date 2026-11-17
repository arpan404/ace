import type {
  MarketDraft,
  MarketDraftSource,
  MarketEntryType,
  MarketMe,
  MarketScanCheck,
} from "@ace/protocol/marketplace";
import { useQueryClient } from "@tanstack/react-query";
import { useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { marketKey, useMarketHome, useMarketInstalled } from "./market-api.ts";
import { findingSentences } from "./market-model.ts";
import { usePublishRequest, usePublishSend } from "./market-publishing.ts";

/*
 * What the publish flow runs on (ADR 0174 §2): the person's own things of a type, a draft made
 * from one and checked by ace's scan (read again until the scan is done), and publishing it with
 * its listing. Pure helpers for the words; the daemon's publish actions do the work.
 */

/** What can be published from the app: a look, a bot recipe, a skill or a plugin. */
export type MarketPublishType = Extract<
  MarketEntryType,
  "suit" | "spade-bot" | "spade-skill" | "spade-plugin"
>;

/** One thing the person could publish, with where it stands in the market. */
export interface MarketPublishItem {
  type: MarketPublishType;
  name: string;
  title: string;
  line: string;
  /** The version to publish: the next one after what's live, or 1.0.0. */
  version: string;
  /** "1.2.0 is live", "Draft", "Never published". */
  state: string;
  /** Where its files come from; a folder's is set on the Item step. */
  source?: MarketDraftSource | undefined;
  /** A draft of it the publisher already has. */
  draft?: string | undefined;
}

/** One line of the Check step: a scan check or a format problem, with its findings. */
export interface MarketCheckRow {
  id: string;
  verdict: MarketScanCheck["verdict"];
  sentence: string;
  /** Under a check that warns or blocks: what it found, one sentence each. */
  found: readonly string[];
}

/** The listing the person writes on Describe. */
export interface MarketListingDraft {
  title: string;
  line: string;
  description: string;
  categories: string[];
  version: string;
}

/** "1.2.0" → "1.2.1"; anything else starts at 1.0.0. */
export function nextVersion(version: string | undefined): string {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return parts ? `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}` : "1.0.0";
}

/** Where one of the person's things stands, and the version they'd publish next. */
export function standing(
  me: MarketMe | undefined,
  type: string,
  name: string,
): { state: string; version: string; draft?: string | undefined } {
  const published = me?.entries.find((entry) => entry.type === type && entry.name === name);
  const draft = me?.drafts.find((each) => each.type === type && each.name === name);
  if (draft) return { state: "Draft", version: draft.version, draft: draft.id };
  if (published?.version)
    return {
      state: `${published.version} is ${published.status === "live" ? "live" : "published"}`,
      version: nextVersion(published.version),
    };
  return { state: "Never published", version: "1.0.0" };
}

/** A draft's checks as the Check step lists them: format problems first, then the scan's. */
export function checkRows(draft: MarketDraft): MarketCheckRow[] {
  const problems: MarketCheckRow[] = draft.problems.map((problem, at) => ({
    id: `problem-${at}`,
    verdict: "block",
    sentence: [problem.path, problem.message].filter(Boolean).join(": "),
    found: [],
  }));
  if (draft.scan.state !== "done") return problems;
  const { report } = draft.scan;
  return [
    ...problems,
    ...report.checks.map((check) => ({
      id: check.id,
      verdict: check.verdict,
      sentence: check.sentence,
      found:
        check.verdict === "pass"
          ? []
          : findingSentences({
              ...report,
              findings: report.findings.filter(
                (finding) => finding.check === check.id && finding.level !== "note",
              ),
            }),
    })),
  ];
}

const waitMs = 800;
const reads = 75;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The person's Suits, as things they could publish. Installs from the market aren't theirs. */
export function useOwnSuits(me: MarketMe | undefined): readonly MarketPublishItem[] {
  const suits = useSuitLibrary().summaries ?? [];
  const installed = useMarketInstalled().data?.installed ?? [];
  const fromMarket = new Set(
    installed.filter((item) => item.type === "suit").map((item) => item.target),
  );
  return suits
    .filter((suit) => !fromMarket.has(suit.id))
    .map((suit) => {
      const where = standing(me, "suit", suit.id);
      return {
        type: "suit",
        name: suit.id,
        title: suit.name,
        line: suit.description,
        source: { kind: "suit", id: suit.id },
        state: where.state,
        version: where.version,
        draft: where.draft,
      };
    });
}

/** The categories a listing can name. */
export function useListingCategories() {
  return useMarketHome().data?.categories ?? [];
}

/** Makes or refreshes a draft and reads it until its scan is done; then publishes it. */
export function usePublishSteps() {
  const ask = usePublishRequest();
  const send = usePublishSend();
  const cache = useQueryClient();
  const settle = async (start: MarketDraft) => {
    let draft = start;
    for (let read = 0; draft.scan.state === "scanning" && read < reads; read++) {
      if (read > 0) await pause(waitMs);
      draft = (await ask({ action: "draftRead", id: draft.id }, "draft")).draft;
    }
    return draft;
  };
  return {
    /** The draft for `item` with its scan done: made now, or its files sent again. */
    async check(item: MarketPublishItem): Promise<MarketDraft> {
      if (!item.source) {
        // A draft carried on from the profile: its files are already up.
        if (!item.draft) throw new Error("No files to check");
        return settle((await ask({ action: "draftRead", id: item.draft }, "draft")).draft);
      }
      const made = item.draft
        ? await ask(
            { action: "draftUpdate", id: item.draft, version: item.version, source: item.source },
            "draft",
          )
        : await ask(
            {
              action: "draftCreate",
              type: item.type,
              name: item.name,
              version: item.version,
              source: item.source,
            },
            "draft",
          );
      return settle(made.draft);
    },
    /** Publishes the draft at the listing's version, then sets the listing's words. */
    async publish(draft: MarketDraft, listing: MarketListingDraft) {
      if (listing.version !== draft.version)
        await ask({ action: "draftUpdate", id: draft.id, version: listing.version }, "draft");
      const published = await ask({ action: "draftPublish", id: draft.id }, "published");
      await send({
        action: "listing",
        type: draft.type,
        name: draft.name,
        listing: {
          title: listing.title.trim(),
          line: listing.line.trim(),
          description: listing.description,
          categories: listing.categories,
          keywords: [],
          links: [],
          previews: [],
        },
      })
        // The version is in either way; a listing edit it refuses keeps the files' own words.
        .catch(() => undefined);
      void cache.invalidateQueries({ queryKey: [...marketKey, "publish"] });
      return published;
    },
  };
}
