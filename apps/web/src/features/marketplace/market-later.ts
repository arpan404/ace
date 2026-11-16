import type { MarketEntrySummary } from "@ace/protocol/marketplace";
import type { TrendMove } from "./market-marks.tsx";

/*
 * The Marketplace's screens whose data the daemon doesn't serve yet (ADR 0173: Trending this
 * week, New and notable, collections, top publishers, publisher pages, your profile and
 * publishing). The screens are built; these hooks are where they plug in.
 *
 * Each type below is only the part of ADR 0173's wire shape (`MarketDiscover`,
 * `MarketPublisherPage`, `MarketMe`, `MarketDraft` in `@ace/protocol/marketplace` on the
 * market-backend-v2 line) that the screens read, so the protocol's values are assignable to them
 * as they are. These are views, not schemas: nothing here parses wire data. Once the protocol
 * carries the `discover`, `publisher` and `publish` operations, each hook becomes a
 * `useDaemonQuery` over `market(client, { op }, op)`. Until then each answers undefined, and a
 * screen without its data isn't rendered.
 */

export interface MarketTrendingView {
  entry: MarketEntrySummary;
  rank: number;
  movement: TrendMove;
}

export interface MarketCollectionView {
  id: string;
  title: string;
  line: string;
  entries: readonly MarketEntrySummary[];
}

export interface MarketTopPublisherView {
  handle: string;
  displayName: string;
  verified: boolean;
  entries: number;
}

/** `MarketDiscover`: what Discover adds to the featured picks once the market ranks them. */
export interface MarketDiscoverView {
  trending: readonly MarketTrendingView[];
  fresh: readonly MarketEntrySummary[];
  collections: readonly MarketCollectionView[];
  publishers: readonly MarketTopPublisherView[];
}

export interface MarketLinkView {
  label?: string | undefined;
  url: string;
}

/** `MarketProfile`. `joined` is a time in ms. */
export interface MarketProfileView {
  handle: string;
  displayName: string;
  bio: string;
  links: readonly MarketLinkView[];
  joined: number;
  verified: boolean;
}

/** `MarketPublisherPage`. */
export interface MarketPublisherView {
  profile: MarketProfileView;
  pinned: readonly MarketEntrySummary[];
  entries: readonly MarketEntrySummary[];
}

export type MarketVersionStatusView = "waiting" | "live" | "not-reviewed" | "withdrawn" | "blocked";

/** `MarketOwnEntrySummary`: one of your publications. */
export interface MarketOwnEntryView {
  type: string;
  name: string;
  title: string;
  version?: string | undefined;
  status?: MarketVersionStatusView | undefined;
  versions: number;
}

/** `MarketDraft`. */
export interface MarketDraftView {
  id: string;
  type: string;
  name: string;
  version: string;
  title: string;
  updated: number;
  problems: readonly { message: string }[];
}

/** `MarketMe`: the signed-in publisher; no `profile` before they make one. */
export interface MarketMeView {
  profile?: MarketProfileView | undefined;
  entries: readonly MarketOwnEntryView[];
  drafts: readonly MarketDraftView[];
}

/** Discover's ranked sections; undefined until the daemon serves `discover`. */
export function useMarketDiscover(): MarketDiscoverView | undefined {
  return undefined;
}

/** A publisher's page; undefined until the daemon serves `publisher`. */
export function useMarketPublisher(handle: string): MarketPublisherView | undefined {
  void handle;
  return undefined;
}

/**
 * The signed-in publisher (`publish` `me`); undefined until the daemon serves it. `signedOut`
 * is true once the daemon answers `signed_out`, so the bar can offer "Sign in to publish".
 */
export function useMarketMe(): { me: MarketMeView | undefined; signedOut: boolean } {
  return { me: undefined, signedOut: false };
}

/** What can be published: a look, a bot recipe, a skill or a plugin. */
export type MarketPublishType = "suit" | "spade-bot" | "spade-skill" | "spade-plugin";

/** One of the person's own things they could publish, with where it stands in the market. */
export interface MarketPublishItem {
  type: MarketPublishType;
  name: string;
  title: string;
  line: string;
  version: string;
  /** "1.2.0 is live", "Draft", "Never published". */
  state: string;
}

/** A scan's check (`MarketScanCheck`): its verdict and its sentence. */
export interface MarketCheckView {
  id: string;
  verdict: "pass" | "warn" | "block";
  sentence: string;
}

/** The listing the person writes on Describe (`MarketListingEdit`'s words). */
export interface MarketListingDraft {
  title: string;
  line: string;
  description: string;
  categories: string[];
  version: string;
}

/**
 * Publishing through the daemon (`publish` actions: `draftCreate`, `draftUpdate`, `listing`,
 * `draftPublish`), as the flow calls it. Undefined until the daemon serves them.
 */
export interface MarketPublishPort {
  items(type: MarketPublishType): readonly MarketPublishItem[];
  /** Makes or refreshes the draft and answers its scan's checks. */
  check(item: MarketPublishItem): Promise<readonly MarketCheckView[]>;
  publish(item: MarketPublishItem, listing: MarketListingDraft): Promise<{ held: boolean }>;
  categories: readonly { id: string; title: string }[];
}

export function useMarketPublishPort(): MarketPublishPort | undefined {
  return undefined;
}
