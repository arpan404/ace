import type { WriteDispatch } from "./write-dispatch.ts";
import type {
  ForgeCreatePrInput,
  ForgePrRef,
  ForgePrStatus,
  ForgeRepository,
  LinkedPullRequest,
} from "@ace/protocol/forge";
import type { StatusRevisions } from "./revisions.ts";
export type MergeMethod = "merge" | "squash" | "rebase";
/**
 * The repository a PR's head branch lives in: this one, or a fork in its network. Owner alone
 * can't tell a same-owner fork (`acme/ace-fork` of `acme/ace`) from the parent.
 */
export type PrHead = { owner: string; name: string };
export interface Forge {
  readonly repository: ForgeRepository;
  readonly revisions?: StatusRevisions;
  /** Immutable validated revisions; reuse unchanged collections and snapshot identity. */
  status(number: number, signal: AbortSignal): Promise<ForgePrStatus>;
  states?(
    numbers: readonly number[],
    signal: AbortSignal,
  ): Promise<Map<number, LinkedPullRequest | null>>;
  /** Open PR lookup by exact branch/base; reconciles publication after an interrupted create. */
  findPr?(
    branch: string,
    base: string,
    signal: AbortSignal,
    head?: PrHead,
  ): Promise<ForgePrRef | null>;
  createPr(
    threadId: string,
    input: ForgeCreatePrInput,
    signal: AbortSignal,
    head?: PrHead,
  ): Promise<ForgePrRef>;
  replyComment(number: number, commentId: number, body: string, signal: AbortSignal): Promise<void>;
  requestReviews(number: number, reviewers: string[], signal: AbortSignal): Promise<void>;
  merge(number: number, headSha: string, method: MergeMethod, signal: AbortSignal): Promise<void>;
  enableAutoMerge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
  ): Promise<void>;
  prMergeState?(
    number: number,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-merge-state").ForgeMergeState>;
  /** Acknowledgement may omit host state; persist it before reading state again. */
  changeMergeState?(
    number: number,
    headSha: string,
    action: "enable" | "disable" | "dequeue",
    method: MergeMethod,
    signal: AbortSignal,
    allowed?: () => boolean,
    dispatch?: WriteDispatch,
  ): Promise<import("@ace/protocol/forge-merge-state").ForgeMergeState | undefined>;
  logTail(jobId: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean }>;
}

/** Hosted repository resources, separate from a thread's primary association. */
export interface ForgeBrowser {
  /** Fresh head/base facts used to validate an isolated checkout before provider admission. */
  prCheckout(
    number: number,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-worktree").ForgePrCheckout>;
  listPrs(
    query: import("@ace/protocol/forge-browser").ForgePrSearch,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-browser").ForgePrList>;
  /** New thread's open PRs, failing PRs and open issues, in one request. */
  openWork(signal: AbortSignal): Promise<import("@ace/protocol/forge-browser").ForgeOpenWork>;
  prDetail(
    number: number,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-browser").ForgePrDetail>;
  /** One page of a PR's commits, newest page first; `before` names the page older than it. */
  prCommits(
    number: number,
    before: string | undefined,
    headSha: string,
    signal: AbortSignal,
  ): Promise<{
    commits: import("@ace/protocol/forge-browser").ForgeCommit[];
    before?: string | undefined;
    alongside?: string[] | undefined;
    total?: number | undefined;
    truncated: boolean;
  }>;
  prFiles(
    input: {
      number: number;
      page: number;
      headSha: string;
      baseSha: string;
      commit?: string | undefined;
      since?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-browser").ForgePrFiles>;
  /** One side of a changed file at a commit, for a diff GitHub withheld. */
  fileContent(
    input: {
      sha: string;
      path: string;
      page: number;
      image?: import("@ace/protocol/forge-file-content").ForgeImageType | undefined;
    },
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-file-content").ForgeFileContent>;
  /** Mentionable people whose login or name matches `query`, 20 at most, for `@`. */
  people(
    query: string,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-people").ForgePerson[]>;
  /** Issues and PRs matching a number or title words, for `#`: exact number, open, recent. */
  references(
    query: string,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-people").ForgeReference[]>;
  /** Who is asked to review, each reviewer's standing review, and GitHub's suggestions. */
  prReviewers(
    number: number,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-people").ForgePrReviewers>;
  /** The forge's own rendering of media URLs from PR and issue text (ADR 0096). */
  renderMedia(
    items: readonly import("@ace/protocol/forge-media").ForgeMediaRequest[],
    signal: AbortSignal,
  ): Promise<import("./github-media.ts").RenderedMedia[]>;
  /** The forge's image-only emoji, shortcode to image URL. */
  emojiImages(signal: AbortSignal): Promise<Record<string, string>>;
}
