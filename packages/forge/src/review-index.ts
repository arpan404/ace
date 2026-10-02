import { createHash } from "node:crypto";
import type { ForgeCheck, ForgeComment, ForgePrStatus, ForgeLinkState } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export type ReviewCandidate =
  | { key: string; type: "ci"; check: ForgeCheck }
  | { key: string; type: "review"; comment: ForgeComment };
/** One link generation and current immutable resource revisions. No delivered history. */
export class ReviewIndex {
  readonly #prefix: string;
  readonly #ignored: ReadonlySet<string>;
  readonly #current = new Map<string, ReviewCandidate>();
  readonly #unobserved = new Set<string>();
  #ci = new Map<string, ReviewCandidate>();
  #reviews = new Map<string, ReviewCandidate>();
  #snapshot: ForgePrStatus | undefined;
  constructor(state: ForgeLinkState, ignored: ReadonlySet<string>) {
    const { link, generation } = state;
    this.#prefix = `forge:${hash(`${generation}:${link.threadId}:${link.pr.repository.host}/${link.pr.repository.owner}/${link.pr.repository.name}#${link.pr.number}`)}`;
    this.#ignored = new Set(ignored);
    if (this.#ignored.size > 100) throw new ForgeError("limit");
  }
  update(status: ForgePrStatus): void {
    if (status === this.#snapshot) return;
    if (
      status.checks.length > 2_000 ||
      status.comments.length > 2_000 ||
      status.reviewThreads.length > 2_000
    )
      throw new ForgeError("limit");
    const previous = this.#snapshot;
    const active = status.state === "open" || status.state === "draft";
    const wasActive = previous?.state === "open" || previous?.state === "draft";
    if (
      active !== wasActive ||
      status.checks !== previous?.checks ||
      status.headSha !== previous?.headSha
    ) {
      const next = new Map<string, ReviewCandidate>();
      if (active)
        for (const check of status.checks) {
          if (check.status !== "failure" && check.status !== "cancelled") continue;
          const key = `${this.#prefix}:ci:${hash(`${status.headSha}:${check.id}:${check.completedAt ?? check.conclusion}`)}`;
          next.set(key, Object.freeze({ key, type: "ci", check }));
        }
      this.#replace(this.#ci, next);
      this.#ci = next;
    }
    if (
      active !== wasActive ||
      status.comments !== previous?.comments ||
      status.reviewThreads !== previous?.reviewThreads
    ) {
      const next = this.#reviewCandidates(status, active);
      this.#replace(this.#reviews, next);
      this.#reviews = next;
    }
    this.#snapshot = status;
  }
  #reviewCandidates(status: ForgePrStatus, active: boolean): Map<string, ReviewCandidate> {
    const result = new Map<string, ReviewCandidate>();
    if (!active) return result;
    const inactive = new Set<number>();
    const comments = new Map(
      status.comments.map((comment) => [`${comment.kind}:${comment.id}`, comment]),
    );
    let count = 0;
    for (const thread of status.reviewThreads)
      for (const comment of thread.comments) {
        if (++count > 2_000) throw new ForgeError("limit");
        if (thread.resolved || thread.outdated) inactive.add(comment.id);
        else if (!comments.has(`inline:${comment.id}`))
          comments.set(`inline:${comment.id}`, comment);
      }
    for (const comment of comments.values()) {
      if (
        (comment.kind === "inline" && inactive.has(comment.id)) ||
        this.#ignored.has(comment.author) ||
        !comment.body.trim() ||
        (comment.kind === "review" &&
          comment.reviewState !== "CHANGES_REQUESTED" &&
          comment.reviewState !== "COMMENTED")
      )
        continue;
      const digest = hash(
        `${comment.updatedAt}:${comment.body}:${comment.file}:${comment.line}:${comment.reviewState ?? ""}`,
      );
      const key = `${this.#prefix}:comment:${comment.kind}:${comment.id}:${digest}`;
      result.set(key, Object.freeze({ type: "review", key, comment }));
    }
    return result;
  }
  #replace(
    previous: ReadonlyMap<string, ReviewCandidate>,
    next: ReadonlyMap<string, ReviewCandidate>,
  ): void {
    for (const key of previous.keys())
      if (!next.has(key)) {
        this.#current.delete(key);
        this.#unobserved.delete(key);
      }
    for (const [key, candidate] of next) {
      if (!this.#current.has(key)) this.#unobserved.add(key);
      this.#current.set(key, candidate);
    }
  }
  get(key: string): ReviewCandidate | undefined {
    return this.#current.get(key);
  }
  /** Admission work remains here until accepted or found in the durable ledger. */
  *pending(): IterableIterator<ReviewCandidate> {
    for (const key of this.#unobserved) {
      const candidate = this.#current.get(key);
      if (candidate) yield candidate;
    }
  }
  observe(key: string): void {
    this.#unobserved.delete(key);
  }
  retry(key: string): void {
    if (this.#current.has(key)) this.#unobserved.add(key);
  }
}
