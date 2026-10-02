import {
  ForgePrRef,
  type ForgePrStatus,
  type ForgeRepository,
  type ForgeCheck,
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
import { PageDecoder, ResourceReader } from "./resource.ts";
import { immutable } from "./immutable.ts";
import { ReviewThreadReader } from "./review-threads.ts";
import { ReadBudget } from "./read-budget.ts";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";

function latestStatuses(items: z.infer<typeof StatusPage>): ForgeCheck[] {
  const latest = new Map<string, ForgeCheck>();
  for (const item of items)
    if (!latest.has(item.context)) latest.set(item.context, mapLegacyStatus(item));
  return [...latest.values()];
}
/** Owns only the latest revisions per resource; no per-PR history maps. */
export class GitHubStatusReader {
  readonly #pr = new PageDecoder(GitHubPr);
  readonly #checks = new ResourceReader(CheckPage, (items) => items.map(mapCheck));
  readonly #statuses = new ResourceReader(StatusPage, latestStatuses);
  readonly #inline = new ResourceReader(CommentPage, (items) => items.map(mapComment));
  readonly #issue = new ResourceReader(CommentPage, (items) => items.map(mapIssueComment));
  readonly #reviews = new ResourceReader(ReviewPage, (items) => items.map(mapReviewComment));
  readonly #threads = new ReviewThreadReader();
  #last: ForgePrStatus | undefined;
  #parts: readonly unknown[] = [];
  #checkParts: readonly unknown[] = [];
  #checkItems: ForgePrStatus["checks"] = [];
  #commentParts: readonly unknown[] = [];
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
      this.#checkItems = immutable([...checks.items, ...statuses.items]);
      this.#checkParts = [checks, statuses];
    }
    if (
      this.#commentParts[0] !== inline ||
      this.#commentParts[1] !== issue ||
      this.#commentParts[2] !== reviews
    ) {
      this.#commentItems = immutable([...inline.items, ...issue.items, ...reviews.items]);
      this.#commentParts = [inline, issue, reviews];
    }
    if (this.#checkItems.length > 2_000 || this.#commentItems.length > 2_000)
      throw new ForgeError("limit");
    const result = mapPr(ref, pr, []);
    result.checks = this.#checkItems;
    result.ci = ciStatus(this.#checkItems);
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
