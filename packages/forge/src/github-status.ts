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
import { PageDecoder, ResourceReader, type Resource } from "./resource.ts";
import { immutable } from "./immutable.ts";
import { ReviewThreadReader } from "./review-threads.ts";
import { ReadBudget } from "./read-budget.ts";
import type { GhApi, Page } from "./http.ts";
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
  /** Each recently read PR's head, newest last. */
  readonly #heads = new Map<number, string>();
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
    // Only the commit checks depend on the head. Everything else starts at once, and so do the
    // checks of the head this PR had at its last read: a head rarely moves between two reads, so
    // a status usually costs one round trip instead of two. A wrong guess is dropped unseen.
    const commitPages = (sha: string) =>
      [
        api.pages(`${root}/commits/${sha}/check-runs?per_page=100&filter=latest`, signal, budget),
        api.pages(`${root}/commits/${sha}/statuses?per_page=100`, signal, budget),
      ] as const;
    const known = this.#heads.get(number);
    const guessed = known === undefined ? undefined : commitPages(known);
    const prRead = api.request(`${root}/pulls/${number}`, signal);
    const reads = [
      this.#inline.read(api, `${root}/pulls/${number}/comments?per_page=100`, signal, budget),
      this.#issue.read(api, `${root}/issues/${number}/comments?per_page=100`, signal, budget),
      this.#reviews.read(api, `${root}/pulls/${number}/reviews?per_page=100`, signal, budget),
      this.#threads.read(api, repository, number, signal, budget),
    ] as const;
    // Handled here: any of them may fail while the PR itself is still being read.
    void Promise.allSettled([...reads, ...(guessed ?? [])]);
    let commits: readonly [Promise<Page[]>, Promise<Page[]>] | undefined;
    try {
      const response = await prRead;
      budget.add(response.bytes);
      const pr = this.#pr.read(response);
      if (pr.number !== number) throw new ForgeError("invalid_data");
      this.#remember(number, pr.head.sha);
      commits = guessed && known === pr.head.sha ? guessed : commitPages(pr.head.sha);
      await Promise.allSettled([...reads, ...commits]);
      const [inline, issue, reviews, threads] = await Promise.all(reads);
      const [checkPages, statusPages] = await Promise.all(commits);
      return this.#publish(ref, number, response, pr, {
        checks: this.#checks.project(checkPages),
        statuses: this.#statuses.project(statusPages),
        inline,
        issue,
        reviews,
        threads,
      });
    } finally {
      // Every read settles before the call returns, so no gh process outlives a failed status.
      await Promise.allSettled([prRead, ...reads, ...(guessed ?? []), ...(commits ?? [])]);
    }
  }
  /** At most this many PRs keep their last head, for guessing the next read's checks. */
  #remember(number: number, sha: string): void {
    this.#heads.delete(number);
    this.#heads.set(number, sha);
    if (this.#heads.size > 256) {
      const oldest = this.#heads.keys().next().value;
      if (oldest !== undefined) this.#heads.delete(oldest);
    }
  }
  #publish(
    ref: ForgePrRef,
    number: number,
    response: Page,
    pr: z.infer<typeof GitHubPr>,
    resources: {
      checks: Resource<ForgeCheck>;
      statuses: Resource<ForgeCheck>;
      inline: Resource<ForgeComment>;
      issue: Resource<ForgeComment>;
      reviews: Resource<ForgeComment>;
      threads: Awaited<ReturnType<ReviewThreadReader["read"]>>;
    },
  ): ForgePrStatus {
    const { checks, statuses, inline, issue, reviews, threads } = resources;
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
