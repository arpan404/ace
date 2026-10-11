import type {
  ForgeCreatePrInput,
  ForgePrRef,
  ForgePrStatus,
  ForgeRepository,
  LinkedPullRequest,
} from "@ace/protocol/forge";
import type { StatusRevisions } from "./revisions.ts";
export type MergeMethod = "merge" | "squash" | "rebase";
export interface Forge {
  readonly repository: ForgeRepository;
  readonly revisions?: StatusRevisions;
  /** Immutable validated revisions; reuse unchanged collections and snapshot identity. */
  status(number: number, signal: AbortSignal): Promise<ForgePrStatus>;
  states?(
    numbers: readonly number[],
    signal: AbortSignal,
  ): Promise<Map<number, LinkedPullRequest | null>>;
  /** Exact branch/base lookup reconciles publication after an interrupted create. */
  findPr?(branch: string, base: string, signal: AbortSignal): Promise<ForgePrRef | null>;
  createPr(threadId: string, input: ForgeCreatePrInput, signal: AbortSignal): Promise<ForgePrRef>;
  replyComment(number: number, commentId: number, body: string, signal: AbortSignal): Promise<void>;
  requestReviews(number: number, reviewers: string[], signal: AbortSignal): Promise<void>;
  merge(number: number, headSha: string, method: MergeMethod, signal: AbortSignal): Promise<void>;
  enableAutoMerge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
  ): Promise<void>;
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
  prDetail(
    number: number,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-browser").ForgePrDetail>;
  prCommits(
    number: number,
    page: number,
    headSha: string,
    signal: AbortSignal,
  ): Promise<{
    commits: import("@ace/protocol/forge-browser").ForgeCommit[];
    nextPage?: number | undefined;
    truncated: boolean;
  }>;
  prFiles(
    input: {
      number: number;
      page: number;
      headSha: string;
      baseSha: string;
      commit?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<import("@ace/protocol/forge-browser").ForgePrFiles>;
}
