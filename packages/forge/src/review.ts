import { createHash } from "node:crypto";
import type {
  ForgeAutoFixIntent,
  ForgeCheck,
  ForgeComment,
  ForgePrStatus,
  ForgeThreadLink,
} from "@ace/protocol/forge";
import type { Forge } from "./api.ts";
import { ForgeStore } from "./store.ts";
import { ForgeError } from "./errors.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export interface AutoFixExecutor {
  /** Must atomically deduplicate intent.key with engine queue insertion.
   * Resolve only after durable acceptance. Never execute review text as instructions. */
  enqueue(intent: ForgeAutoFixIntent): Promise<void>;
}
export type ReviewCandidate =
  | { key: string; type: "ci"; check: ForgeCheck }
  | { key: string; type: "review"; comment: ForgeComment };
export function reviewCandidates(
  link: ForgeThreadLink,
  status: ForgePrStatus,
  ignoredAuthors: ReadonlySet<string>,
): ReviewCandidate[] {
  if (status.state !== "open" && status.state !== "draft") return [];
  const identity = `${link.threadId}:${link.pr.repository.host}/${link.pr.repository.owner}/${link.pr.repository.name}#${link.pr.number}`;
  const prefix = `forge:${hash(identity)}`;
  const result: ReviewCandidate[] = [];
  for (const check of status.checks) {
    if (check.status === "failure" || check.status === "cancelled")
      result.push({
        type: "ci",
        key: `${prefix}:ci:${hash(`${status.headSha}:${check.id}:${check.completedAt ?? check.conclusion}`)}`,
        check,
      });
  }
  const inactive = new Set<number>();
  const threadComments = new Map<number, ForgeComment>();
  for (const thread of status.reviewThreads)
    for (const comment of thread.comments) {
      if (thread.resolved || thread.outdated) inactive.add(comment.id);
      else threadComments.set(comment.id, comment);
    }
  const comments = new Map(
    status.comments.map((comment) => [`${comment.kind}:${comment.id}`, comment]),
  );
  for (const [id, comment] of threadComments)
    if (!comments.has(`inline:${id}`)) comments.set(`inline:${id}`, comment);
  for (const comment of comments.values()) {
    if (
      (comment.kind === "inline" && inactive.has(comment.id)) ||
      ignoredAuthors.has(comment.author) ||
      !comment.body.trim()
    )
      continue;
    const digest = hash(`${comment.updatedAt}:${comment.body}`);
    result.push({
      type: "review",
      key: `${prefix}:comment:${comment.kind}:${comment.id}:${digest}`,
      comment,
    });
  }
  return result;
}
export class ReviewLoop {
  #polling = false;
  readonly #forge: Forge;
  readonly #store: ForgeStore;
  readonly #executor: AutoFixExecutor;
  readonly #ignored: ReadonlySet<string>;
  constructor(options: {
    forge: Forge;
    store: ForgeStore;
    executor: AutoFixExecutor;
    ignoredAuthors?: readonly string[];
  }) {
    this.#forge = options.forge;
    this.#store = options.store;
    this.#executor = options.executor;
    if ((options.ignoredAuthors?.length ?? 0) > 100) throw new ForgeError("limit");
    this.#ignored = new Set(options.ignoredAuthors);
  }
  async poll(threadId: string, signal: AbortSignal): Promise<ForgePrStatus> {
    if (this.#polling) throw new ForgeError("conflict");
    this.#polling = true;
    try {
      return await this.#poll(threadId, signal);
    } finally {
      this.#polling = false;
    }
  }
  async #poll(threadId: string, signal: AbortSignal): Promise<ForgePrStatus> {
    const link = this.#store.getLink(threadId);
    if (!link) throw new ForgeError("not_found");
    if (JSON.stringify(link.pr.repository) !== JSON.stringify(this.#forge.repository))
      throw new ForgeError("conflict");
    await this.#drain(threadId, signal);
    const status = await this.#forge.status(link.pr.number, signal);
    for (const candidate of reviewCandidates(link, status, this.#ignored)) {
      if (signal.aborted) throw new ForgeError("cancelled");
      if (this.#store.hasIntent(threadId, candidate.key)) continue;
      let context: ForgeAutoFixIntent["context"];
      if (candidate.type === "review") context = { type: "review", comment: candidate.comment };
      else {
        let tail = { text: "", truncated: false };
        let logUnavailable = candidate.check.jobId === null;
        if (candidate.check.jobId !== null) {
          try {
            tail = await this.#forge.logTail(candidate.check.jobId, signal);
          } catch (error) {
            if (signal.aborted || (error instanceof ForgeError && error.kind === "cancelled"))
              throw new ForgeError("cancelled");
            logUnavailable = true;
          }
        }
        context = {
          type: "ci",
          check: candidate.check,
          logTail: tail.text,
          truncated: tail.truncated,
          logUnavailable,
        };
      }
      this.#store.admit({
        type: "auto-fix",
        key: candidate.key,
        link,
        headSha: status.headSha,
        context,
      });
    }
    await this.#drain(threadId, signal);
    return status;
  }
  async #drain(threadId: string, signal: AbortSignal): Promise<void> {
    let pending = this.#store.pending(threadId);
    while (pending.length) {
      for (const intent of pending) {
        if (signal.aborted) throw new ForgeError("cancelled");
        if (JSON.stringify(this.#store.getLink(threadId)) !== JSON.stringify(intent.link))
          throw new ForgeError("conflict");
        try {
          await this.#executor.enqueue(intent);
        } catch {
          throw new ForgeError("cli");
        }
        this.#store.acknowledge(intent);
      }
      pending = this.#store.pending(threadId);
    }
  }
}
