import type {
  ForgeCreatePrInput,
  ForgePrRef,
  ForgePrStatus,
  ForgeRepository,
} from "@ace/protocol/forge";
export type MergeMethod = "merge" | "squash" | "rebase";
export interface Forge {
  readonly repository: ForgeRepository;
  status(number: number, signal: AbortSignal): Promise<ForgePrStatus>;
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
