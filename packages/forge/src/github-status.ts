import {
  ForgePrRef,
  type ForgePrStatus,
  type ForgeRepository,
  type ForgeCheck,
  type ForgeComment,
} from "@ace/protocol/forge";
import type { z } from "zod";
import { CheckPage, CommentPage, GitHubPr, StatusPage, ReviewPage } from "./github-schemas.ts";
import {
  mapPr,
  mapCheck,
  mapComment,
  mapIssueComment,
  mapLegacyStatus,
  mapReviewComment,
  ciStatus,
} from "./status.ts";
import { sameCheck, sameStatus, sameComment, sameReview } from "./projections.ts";
import { StatusRevisions, commentIdentity, checkIdentity } from "./revisions.ts";
import { PageDecoder, ResourceReader } from "./resource.ts";
import { immutable } from "./immutable.ts";
import { ReviewThreadReader } from "./review-threads.ts";
import { ReadBudget } from "./read-budget.ts";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";

function latestStatuses(items: ForgeCheck[]): ForgeCheck[] {
  const latest = new Map<string, ForgeCheck>();
  for (const item of items) if (!latest.has(item.name)) latest.set(item.name, item);
  return [...latest.values()];
}
/** Owns only the latest revisions per resource; no per-PR history maps. */
export class GitHubStatusReader {
  readonly #pr = new PageDecoder(GitHubPr);
  readonly #checks = new ResourceReader(CheckPage, mapCheck, checkIdentity, sameCheck);
  readonly #statuses = new ResourceReader(StatusPage, mapLegacyStatus, checkIdentity, sameStatus);
  readonly #inline = new ResourceReader<z.infer<typeof CommentPage>[number], ForgeComment>(
    CommentPage,
    mapComment,
    commentIdentity,
    sameComment,
  );
  readonly #issue = new ResourceReader<z.infer<typeof CommentPage>[number], ForgeComment>(
    CommentPage,
    mapIssueComment,
    commentIdentity,
    sameComment,
  );
  readonly #reviews = new ResourceReader<z.infer<typeof ReviewPage>[number], ForgeComment>(
    ReviewPage,
    mapReviewComment,
    commentIdentity,
    sameReview,
  );
  readonly #threads: ReviewThreadReader;
  readonly #revisions: StatusRevisions;
  constructor(revisions: StatusRevisions) {
    this.#revisions = revisions;
    this.#threads = new ReviewThreadReader(revisions);
  }
  #last: ForgePrStatus | undefined;
  #parts: readonly unknown[] = [];
  #checkParts: readonly import("./resource.ts").Resource<ForgeCheck>[] = [];
  #legacySource: ForgeCheck[] | undefined;
  #legacyItems: ForgeCheck[] = [];
  #checkItems: ForgePrStatus["checks"] = [];
  #commentParts: readonly import("./resource.ts").Resource<ForgePrStatus["comments"][number]>[] =
    [];
  #commentItems: ForgePrStatus["comments"] = [];
  async read(
    api: GhApi,
    root: string,
    repository: ForgeRepository,
    number: number,
    signal: AbortSignal,
  ): Promise<ForgePrStatus> {
    const budget = new ReadBudget();
    const ref = ForgePrRef.parse({ repository, number });
    const response = await api.request(`${root}/pulls/${number}`, signal);
    budget.add(response.bytes);
    const pr = this.#pr.read(response);
    if (pr.number !== number) throw new ForgeError("invalid_data");
    const sha = pr.head.sha;
    const checks = await this.#checks.read(
      api,
      `${root}/commits/${sha}/check-runs?per_page=100&filter=latest`,
      signal,
      budget,
    );
    const statuses = await this.#statuses.read(
      api,
      `${root}/commits/${sha}/statuses?per_page=100`,
      signal,
      budget,
    );
    const inline = await this.#inline.read(
      api,
      `${root}/pulls/${number}/comments?per_page=100`,
      signal,
      budget,
    );
    const issue = await this.#issue.read(
      api,
      `${root}/issues/${number}/comments?per_page=100`,
      signal,
      budget,
    );
    const reviews = await this.#reviews.read(
      api,
      `${root}/pulls/${number}/reviews?per_page=100`,
      signal,
      budget,
    );
    const threads = await this.#threads.read(api, repository, number, signal, budget);
    const parts = [response, checks, statuses, inline, issue, reviews, threads];
    if (
      this.#last?.ref.number === number &&
      parts.every((part, index) => part === this.#parts[index])
    )
      return this.#last;
    if (this.#checkParts[0] !== checks || this.#checkParts[1] !== statuses) {
      const previousLegacy = this.#legacyItems;
      if (this.#legacySource !== statuses.items) {
        this.#legacyItems = latestStatuses(statuses.items);
        this.#legacySource = statuses.items;
      }
      const changedChecks = this.#checks.versions.changes(
        this.#checkParts[0]?.items ?? [],
        checks.items,
        checkIdentity,
      );
      const changedLegacy = this.#revisions.checks.changes(
        previousLegacy,
        this.#legacyItems,
        checkIdentity,
      );
      const items = [...checks.items, ...this.#legacyItems];
      this.#checkItems = this.#revisions.checks.retain(this.#checkItems, items, {
        upsert: [...changedChecks.upsert, ...changedLegacy.upsert],
        removed: [...changedChecks.removed, ...changedLegacy.removed],
      });
      this.#checkParts = [checks, statuses];
    }
    if (
      this.#commentParts[0] !== inline ||
      this.#commentParts[1] !== issue ||
      this.#commentParts[2] !== reviews
    ) {
      const next = [...inline.items, ...issue.items, ...reviews.items];
      const readers = [this.#inline, this.#issue, this.#reviews];
      const resources = [inline, issue, reviews];
      const upsert = [];
      const removed = [];
      for (let position = 0; position < resources.length; position++) {
        const resource = resources[position];
        const reader = readers[position];
        const previous = this.#commentParts[position];
        if (!resource || !reader) throw new ForgeError("invalid_data");
        const before = previous?.items ?? [];
        const changes = reader.versions.changes(before, resource.items, commentIdentity);
        upsert.push(...changes.upsert);
        removed.push(...changes.removed);
      }
      this.#commentItems = this.#revisions.comments.retain(this.#commentItems, next, {
        upsert,
        removed,
      });
      this.#commentParts = [inline, issue, reviews];
    }
    if (this.#checkItems.length > 2_000 || this.#commentItems.length > 2_000)
      throw new ForgeError("limit");
    const result = mapPr(ref, pr, []);
    result.checks = this.#checkItems;
    result.ci =
      this.#last?.checks === this.#checkItems ? this.#last.ci : ciStatus(this.#checkItems);
    result.comments = this.#commentItems;
    result.reviewThreads = threads.threads;
    result.raw = {
      pr: response.body,
      checks: checks.raw,
      statuses: statuses.raw,
      reviewComments: inline.raw,
      issueComments: issue.raw,
      reviews: reviews.raw,
      reviewThreads: threads.raw,
    };
    this.#parts = parts;
    this.#last = immutable(result);
    return this.#last;
  }
}
