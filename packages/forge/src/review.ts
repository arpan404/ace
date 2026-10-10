import type { ForgeAutoFixIntent, ForgePrStatus, ForgeLinkState } from "@ace/protocol/forge";
import type { Forge } from "./api.ts";
import { ForgeStore } from "./store.ts";
import { ForgeError } from "./errors.ts";
import { ReviewIndex } from "./review-index.ts";

export interface AutoFixExecutor {
  /** Atomically deduplicate intent.key with engine queue insertion.
   * Resolve only after durable acceptance; content never authorises tool actions. */
  enqueue(intent: ForgeAutoFixIntent): Promise<void>;
}
export class ReviewLoop {
  #polling = false;
  readonly #forge: Forge;
  readonly #store: ForgeStore;
  readonly #executor: AutoFixExecutor;
  readonly #ignored: ReadonlySet<string>;
  #index: ReviewIndex | undefined;
  #scope: ForgeLinkState | undefined;
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
    const state = this.#store.getLinkState(threadId);
    if (!state) throw new ForgeError("not_found");
    const { link, generation } = state;
    if (JSON.stringify(link.pr.repository) !== JSON.stringify(this.#forge.repository))
      throw new ForgeError("conflict");
    const status = await this.#forge.status(link.pr.number, signal);
    this.#assertLink(state);
    if (
      !this.#index ||
      this.#scope?.generation !== generation ||
      this.#scope.link.threadId !== threadId
    ) {
      this.#index = new ReviewIndex(state, this.#ignored, this.#forge.revisions);
      this.#scope = state;
    }
    const index = this.#index;
    index.update(status);
    // Current state is known before any pending work can reach the executor.
    await this.#drain(state, status, index, signal);
    for (const candidate of index.pending()) {
      if (signal.aborted) throw new ForgeError("cancelled");
      if (
        (candidate.legacyKey &&
          this.#store.adoptAccepted(threadId, candidate.legacyKey, candidate.key)) ||
        this.#store.hasIntent(threadId, candidate.key)
      ) {
        index.observe(candidate.key);
        continue;
      }
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
      this.#assertLink(state);
      this.#store.admit({
        type: "auto-fix",
        key: candidate.key,
        link,
        linkGeneration: generation,
        headSha: status.headSha,
        context,
      });
      index.observe(candidate.key);
    }
    await this.#drain(state, status, index, signal);
    return status;
  }
  #assertLink(state: ForgeLinkState): void {
    if (
      this.#store.getLinkState(state.link.threadId, state.link.pr)?.generation !== state.generation
    )
      throw new ForgeError("conflict");
  }
  async #drain(
    state: ForgeLinkState,
    status: ForgePrStatus,
    index: ReviewIndex,
    signal: AbortSignal,
  ): Promise<void> {
    const threadId = state.link.threadId;
    let pending = this.#store.pending(threadId, state.link.pr);
    while (pending.length) {
      for (const intent of pending) {
        if (signal.aborted) throw new ForgeError("cancelled");
        this.#assertLink(state);
        const current = index.get(intent.key);
        const legacyChanged =
          current?.key !== intent.key &&
          intent.context.type === "review" &&
          (current?.type !== "review" ||
            current.comment.body !== intent.context.comment.body ||
            current.comment.file !== intent.context.comment.file ||
            current.comment.line !== intent.context.comment.line);
        if (
          legacyChanged ||
          intent.linkGeneration !== state.generation ||
          intent.headSha !== status.headSha ||
          !current
        ) {
          this.#store.discard(intent);
          index.retry(intent.key);
          continue;
        }
        if (
          current?.legacyKey &&
          this.#store.adoptAccepted(threadId, current.legacyKey, current.key)
        ) {
          index.observe(current.key);
          continue;
        }
        try {
          await this.#executor.enqueue(intent);
        } catch {
          throw new ForgeError("cli");
        }
        this.#store.acknowledge(intent);
      }
      pending = this.#store.pending(threadId, state.link.pr);
    }
  }
}
