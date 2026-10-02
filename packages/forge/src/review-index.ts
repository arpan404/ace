import { createHash } from "node:crypto";
import type { ForgeCheck, ForgeComment, ForgePrStatus, ForgeLinkState } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";
import { StatusRevisions, commentIdentity, checkIdentity } from "./revisions.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Thread = ForgePrStatus["reviewThreads"][number];
export type ReviewCandidate =
  | { key: string; legacyKey?: string | undefined; type: "ci"; check: ForgeCheck }
  | { key: string; legacyKey?: string | undefined; type: "review"; comment: ForgeComment };
/** Current rows and admission work only. Versioned inputs update affected rows. */
export class ReviewIndex {
  readonly #prefix: string;
  readonly #legacy: string | undefined;
  readonly #ignored: ReadonlySet<string>;
  readonly #versions: StatusRevisions;
  readonly #current = new Map<string, ReviewCandidate>();
  readonly #aliases = new Map<string, ReviewCandidate>();
  readonly #feedbackCandidates = new WeakMap<ForgeComment, ReviewCandidate>();
  readonly #byRow = new Map<string, ReviewCandidate>();
  readonly #unobserved = new Set<string>();
  readonly #checks = new Map<string, ForgeCheck>();
  readonly #comments = new Map<string, ForgeComment>();
  readonly #threads = new Map<string, Thread>();
  readonly #inactive = new Map<number, number>();
  readonly #supplements = new Map<number, Map<string, ForgeComment>>();
  #threadCount = 0;
  #snapshot: ForgePrStatus | undefined;
  constructor(
    state: ForgeLinkState,
    ignored: ReadonlySet<string>,
    versions = new StatusRevisions(),
  ) {
    const { link, generation } = state;
    const scope = `${link.threadId}:${link.pr.repository.host}/${link.pr.repository.owner}/${link.pr.repository.name}#${link.pr.number}`;
    this.#prefix = `forge:${hash(`${generation}:${scope}`)}`;
    this.#legacy = generation === 1 ? `forge:${hash(scope)}` : undefined;
    if (ignored.size > 100) throw new ForgeError("limit");
    this.#ignored = new Set(ignored);
    this.#versions = versions;
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
    const ci = new Set<string>();
    const reviews = new Set<string>();
    const checks = this.#versions.checks.changes(
      previous?.checks ?? [],
      status.checks,
      checkIdentity,
    );
    for (const item of checks.removed) {
      this.#checks.delete(item.id);
      ci.add(item.id);
    }
    for (const item of checks.upsert) {
      this.#checks.set(item.id, item);
      ci.add(item.id);
    }
    const comments = this.#versions.comments.changes(
      previous?.comments ?? [],
      status.comments,
      commentIdentity,
    );
    for (const item of comments.removed) {
      const id = commentIdentity(item);
      this.#comments.delete(id);
      reviews.add(id);
    }
    for (const item of comments.upsert) {
      const id = commentIdentity(item);
      this.#comments.set(id, item);
      reviews.add(id);
    }
    const threads = this.#versions.threads.changes(
      previous?.reviewThreads ?? [],
      status.reviewThreads,
      (thread) => thread.id,
    );
    for (const item of threads.removed) this.#removeThread(item.id, reviews);
    for (const item of threads.upsert) {
      this.#removeThread(item.id, reviews);
      this.#threads.set(item.id, item);
      this.#threadCount += item.comments.length;
      if (this.#threadCount > 2_000) throw new ForgeError("limit");
      for (const comment of item.comments) {
        reviews.add(`inline:${comment.id}`);
        if (item.resolved || item.outdated)
          this.#inactive.set(comment.id, (this.#inactive.get(comment.id) ?? 0) + 1);
        else {
          const entries = this.#supplements.get(comment.id) ?? new Map<string, ForgeComment>();
          entries.set(item.id, comment);
          this.#supplements.set(comment.id, entries);
        }
      }
    }
    if (active !== wasActive || status.headSha !== previous?.headSha) {
      for (const id of this.#checks.keys()) ci.add(id);
      for (const candidate of this.#current.values())
        if (candidate.type === "ci") ci.add(candidate.check.id);
    }
    if (active !== wasActive) {
      for (const id of this.#comments.keys()) reviews.add(id);
      for (const id of this.#supplements.keys()) reviews.add(`inline:${id}`);
      for (const [row, candidate] of this.#byRow) if (candidate.type === "review") reviews.add(row);
    }
    for (const id of ci) {
      const check = this.#checks.get(id);
      const digest =
        check && hash(`${status.headSha}:${check.id}:${check.completedAt ?? check.conclusion}`);
      const candidate: ReviewCandidate | undefined =
        active && check && (check.status === "failure" || check.status === "cancelled")
          ? {
              type: "ci",
              key: `${this.#prefix}:ci:${digest}`,
              legacyKey: this.#legacy && `${this.#legacy}:ci:${digest}`,
              check,
            }
          : undefined;
      this.#set(`ci:${id}`, candidate);
    }
    for (const id of reviews) this.#set(id, active ? this.#review(id) : undefined);
    this.#snapshot = status;
  }
  #removeThread(id: string, affected: Set<string>): void {
    const old = this.#threads.get(id);
    if (!old) return;
    this.#threads.delete(id);
    this.#threadCount -= old.comments.length;
    for (const comment of old.comments) {
      affected.add(`inline:${comment.id}`);
      if (old.resolved || old.outdated) {
        const count = (this.#inactive.get(comment.id) ?? 1) - 1;
        if (count) this.#inactive.set(comment.id, count);
        else this.#inactive.delete(comment.id);
      } else {
        const entries = this.#supplements.get(comment.id);
        entries?.delete(id);
        if (!entries?.size) this.#supplements.delete(comment.id);
      }
    }
  }
  #review(id: string): ReviewCandidate | undefined {
    const comment =
      this.#comments.get(id) ??
      (id.startsWith("inline:")
        ? this.#supplements
            .get(Number(id.slice(7)))
            ?.values()
            .next().value
        : undefined);
    if (
      !comment ||
      (comment.kind === "inline" && this.#inactive.has(comment.id)) ||
      this.#ignored.has(comment.author) ||
      !comment.body.trim() ||
      (comment.kind === "review" &&
        comment.reviewState !== "CHANGES_REQUESTED" &&
        comment.reviewState !== "COMMENTED")
    )
      return undefined;
    const known = this.#feedbackCandidates.get(comment);
    if (known) return known;
    const digest = hash(
      `${comment.updatedAt}:${comment.body}:${comment.file}:${comment.line}:${comment.reviewState ?? ""}`,
    );
    const candidate: ReviewCandidate = {
      type: "review",
      key: `${this.#prefix}:comment:${id}:${digest}`,
      comment,
      legacyKey:
        this.#legacy && comment.kind !== "review"
          ? `${this.#legacy}:comment:${id}:${hash(`${comment.updatedAt}:${comment.body}`)}`
          : undefined,
    };
    Object.freeze(candidate);
    this.#feedbackCandidates.set(comment, candidate);
    return candidate;
  }
  #set(row: string, next: ReviewCandidate | undefined): void {
    const old = this.#byRow.get(row);
    if (old?.key === next?.key) return;
    if (old) {
      if (old.type === "ci") this.#current.delete(old.key);
      this.#unobserved.delete(old.key);
      if (!next) this.#byRow.delete(row);
      if (old.type === "ci" && old.legacyKey) this.#aliases.delete(old.legacyKey);
    }
    if (next) {
      Object.freeze(next);
      this.#byRow.set(row, next);
      if (next.type === "ci") this.#current.set(next.key, next);
      this.#unobserved.add(next.key);
      if (next.type === "ci" && next.legacyKey) this.#aliases.set(next.legacyKey, next);
    }
  }
  get(key: string): ReviewCandidate | undefined {
    for (const prefix of [this.#prefix, this.#legacy]) {
      if (!prefix || !key.startsWith(`${prefix}:comment:`)) continue;
      const row = key.slice(prefix.length + 9, -65);
      const candidate = this.#byRow.get(row);
      if (candidate?.key === key || candidate?.legacyKey === key) return candidate;
    }
    return this.#current.get(key) ?? this.#aliases.get(key);
  }
  *pending(): IterableIterator<ReviewCandidate> {
    for (const key of this.#unobserved) {
      const candidate = this.get(key);
      if (candidate) yield candidate;
    }
  }
  observe(key: string): void {
    this.#unobserved.delete(key);
  }
  retry(key: string): void {
    const current = this.get(key);
    if (current) this.#unobserved.add(current.key);
  }
}
