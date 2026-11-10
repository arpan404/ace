import {
  ForgePrRef,
  ForgePrStatus,
  ForgeRepository,
  type ForgePrStatus as ForgePrStatusType,
} from "@ace/protocol/forge";
import {
  ForgeFilePageInput,
  ForgePrDetail,
  ForgePrFiles,
  ForgePrList,
  ForgePrSearch,
  type ForgePrDetail as ForgePrDetailType,
  type ForgePrFiles as ForgePrFilesType,
  type ForgePrList as ForgePrListType,
} from "@ace/protocol/forge-browser";
import { ForgePrCheckout } from "@ace/protocol/forge-worktree";
import { GitLabReviews } from "./gitlab-reviews.ts";
import { GitLabConversation } from "./gitlab-conversation.ts";
import { GitLabApi } from "./gitlab-api.ts";
import type { ForgeReader } from "./api.ts";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { clipLabels, clipText } from "./host-text.ts";
import { redactData } from "./redact.ts";
import { ReadBudget } from "./read-budget.ts";
import {
  DiffPage,
  Mr,
  MrList,
  PinnedShas,
  SourceProject,
  changeFile,
  changesCount,
  mrUrl,
  headOf,
  listTotals,
  must,
  prRow,
  requireSha,
  statusState,
  type GitLabMr,
} from "./gitlab-records.ts";

/** Read-only GitLab merge request adapter over the user's glab CLI.
 * Primary docs: docs.gitlab.com/cli/api/ and docs.gitlab.com/api/merge_requests/.
 * No mutations; the caller's runner already verified API identity. */
export class GitLabReader implements ForgeReader {
  readonly repository: ForgeRepository;
  readonly #api: GitLabApi;
  readonly conversation: GitLabConversation;
  readonly reviews: GitLabReviews;
  readonly #host: string;
  readonly #project: string;

  constructor(options: { repository: ForgeRepository; runner: CommandRunner }) {
    this.repository = ForgeRepository.parse(options.repository);
    if (this.repository.forge !== "gitlab") throw new ForgeError("unsupported");
    if (!options.runner) throw new ForgeError("unsupported");
    this.#api = new GitLabApi(options.runner, this.repository.host);
    this.reviews = new GitLabReviews(options);
    this.conversation = new GitLabConversation(this.#api, this.repository);
    this.#host = this.repository.host;
    this.#project = encodeURIComponent(`${this.repository.owner}/${this.repository.name}`);
  }

  #ref(number: number): { repository: ForgeRepository; number: number } {
    return ForgePrRef.parse({ repository: this.repository, number });
  }

  #get(endpoint: string, signal: AbortSignal, budget: ReadBudget) {
    return this.#api.get(endpoint, signal, budget);
  }

  #statusOf(mr: GitLabMr): ForgePrStatusType {
    return must(
      ForgePrStatus.safeParse({
        ref: this.#ref(mr.iid),
        title: clipText(mr.title),
        url: mrUrl(this.repository, mr.iid),
        headSha: requireSha(headOf(mr)),
        state: statusState(mr),
        mergeability:
          mr.has_conflicts === true
            ? "conflicting"
            : mr.detailed_merge_status === "mergeable"
              ? "mergeable"
              : "unknown",
        // Pipeline state is never fetched: unknown, not none.
        ci: "unknown",
        checks: [],
        comments: [],
        reviewThreads: [],
        raw: redactData(mr),
      }),
    );
  }

  /** A fork's source project, resolved to owner/name; anything else is unsupported. */
  async #sourceRepository(
    id: number,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<ForgeRepository> {
    const { body } = await this.#get(`projects/${id}`, signal, budget);
    const parsed = SourceProject.safeParse(body);
    const path = parsed.success ? parsed.data.path_with_namespace : "";
    const slash = path.lastIndexOf("/");
    const repo =
      slash > 0
        ? ForgeRepository.safeParse({
            forge: "gitlab",
            host: this.#host,
            owner: path.slice(0, slash),
            name: path.slice(slash + 1),
          })
        : null;
    if (!repo?.success) throw new ForgeError("unsupported");
    return repo.data;
  }

  /**
   * The MR's head repository for detail: this one only when the ids prove it,
   * else null. Missing ids prove nothing, so null rather than an invented repo.
   */
  #detailHeadRepository(mr: GitLabMr): ForgeRepository | null {
    const source = mr.source_project_id;
    const target = mr.target_project_id ?? mr.project_id;
    return source !== undefined && target !== undefined && source === target
      ? this.repository
      : null;
  }

  /**
   * The MR's head repository for checkout: this one when the ids prove it,
   * else the resolved fork source. Anything unresolvable is unsupported.
   */
  async #checkoutHeadRepository(
    mr: GitLabMr,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<ForgeRepository> {
    const source = mr.source_project_id;
    const target = mr.target_project_id ?? mr.project_id;
    if (source === undefined || target === undefined) throw new ForgeError("unsupported");
    if (source === target) return this.repository;
    return this.#sourceRepository(source, signal, budget);
  }

  async status(number: number, signal: AbortSignal): Promise<ForgePrStatusType> {
    this.#ref(number);
    const budget = new ReadBudget();
    const { body } = await this.#get(
      `projects/${this.#project}/merge_requests/${number}`,
      signal,
      budget,
    );
    const parsed = Mr.safeParse(body);
    if (!parsed.success || parsed.data.iid !== number) throw new ForgeError("invalid_data");
    const status = this.#statusOf(parsed.data);
    const snapshot = await this.conversation.snapshot(number, status.headSha, signal, budget);
    return { ...status, comments: snapshot.comments, reviewThreads: snapshot.reviewThreads };
  }

  async listPrs(query: ForgePrSearch, signal: AbortSignal): Promise<ForgePrListType> {
    const q = ForgePrSearch.parse(query);
    if (q.ci !== "any" || q.review !== "any") throw new ForgeError("unsupported");
    if (q.author !== "" || q.reviewer !== "" || q.assignee !== "")
      throw new ForgeError("unsupported");
    if (q.labels.length > 0) throw new ForgeError("unsupported");
    if (q.sort === "comments") throw new ForgeError("unsupported");
    const params = new URLSearchParams({
      per_page: "25",
      page: String(q.page),
      order_by: q.sort === "created" ? "created_at" : "updated_at",
      sort: q.order,
    });
    if (q.search.trim()) params.set("search", q.search.trim());
    if (q.state === "open") {
      params.set("state", "opened");
      params.set("wip", "no");
    } else if (q.state === "draft") {
      params.set("state", "opened");
      params.set("wip", "yes");
    } else if (q.state === "active") params.set("state", "opened");
    else if (q.state === "closed") params.set("state", "closed");
    else if (q.state === "merged") params.set("state", "merged");
    else if (q.state === "all") params.set("state", "all");
    else throw new ForgeError("unsupported");
    const budget = new ReadBudget();
    const { body, headers } = await this.#get(
      `projects/${this.#project}/merge_requests?${params}`,
      signal,
      budget,
    );
    const items = MrList.safeParse(body);
    if (!items.success) throw new ForgeError("invalid_data");
    // Bounded totals: one small count read per state (per_page=1, x-total header),
    // under the same search so totals match the filtered page.
    const counts = await this.#counts(q.search.trim(), signal, budget);
    const read = items.data.slice(0, 25);
    // A row in a state lists can't express is dropped, and the list says it is incomplete.
    const rows = read.flatMap((item) => prRow(this.repository, item) ?? []);
    const paging = listTotals({
      state: q.state,
      page: q.page,
      rowCount: read.length,
      headers,
      counts,
    });
    return must(
      ForgePrList.safeParse({
        repository: this.repository,
        items: rows,
        total: paging.total,
        ...(paging.nextPage !== undefined ? { nextPage: paging.nextPage } : {}),
        counts,
        incomplete: paging.incomplete || rows.length < read.length,
        truncated: paging.truncated,
      }),
    );
  }

  /** Server totals per state; capped at the 1000-item bound, never fetched fully. */
  async #counts(
    search: string,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<{ open: number; draft: number; closed: number; merged: number; capped: boolean }> {
    const scope = search ? `&search=${encodeURIComponent(search)}` : "";
    const read = async (extra: string): Promise<{ total: number; capped: boolean }> => {
      try {
        const { headers } = await this.#get(
          `projects/${this.#project}/merge_requests?per_page=1&page=1${extra}${scope}`,
          signal,
          budget,
        );
        const total = Number(headers["x-total"]);
        if (!Number.isInteger(total) || total < 0) return { total: 0, capped: true };
        return { total: Math.min(total, 1000), capped: total > 1000 };
      } catch (error) {
        signal.throwIfAborted();
        // Cancellation, denial and exhaustion are the caller's to see, never a zero count.
        if (
          error instanceof ForgeError &&
          (error.kind === "cancelled" || error.kind === "forbidden" || error.kind === "limit")
        )
          throw error;
        return { total: 0, capped: true };
      }
    };
    const [opened, closed, merged, drafts] = await Promise.all([
      read("&state=opened&wip=no"),
      read("&state=closed"),
      read("&state=merged"),
      read("&state=opened&wip=yes"),
    ]);
    const capped = opened.capped || closed.capped || merged.capped || drafts.capped;
    return {
      open: opened.total,
      draft: drafts.total,
      closed: closed.total,
      merged: merged.total,
      capped,
    };
  }

  async prDetail(number: number, signal: AbortSignal): Promise<ForgePrDetailType> {
    this.#ref(number);
    const budget = new ReadBudget();
    const { body } = await this.#get(
      `projects/${this.#project}/merge_requests/${number}`,
      signal,
      budget,
    );
    const parsed = Mr.safeParse(body);
    if (!parsed.success || parsed.data.iid !== number) throw new ForgeError("invalid_data");
    const mr = parsed.data;
    const changed = changesCount(mr) ?? (await this.#diffCount(number, signal, budget));
    const status = this.#statusOf(mr);
    const snapshot = await this.conversation.snapshot(number, status.headSha, signal, budget);
    const commits = await this.conversation.commits(
      number,
      undefined,
      status.headSha,
      signal,
      budget,
    );
    const reviewers = await this.conversation.reviewers(number, signal, budget);
    return must(
      ForgePrDetail.safeParse({
        readOnly: false,
        unavailableResources: [
          "checks",
          ...(commits.total === undefined && commits.before !== undefined
            ? ["commits" as const]
            : []),
          ...(changed ? [] : ["fileCount" as const]),
        ],
        status: { ...status, comments: snapshot.comments, reviewThreads: snapshot.reviewThreads },
        ...(mr.updated_at ? { updatedAt: mr.updated_at } : {}),
        ...(mr.created_at ? { createdAt: mr.created_at } : {}),
        body: clipText(typeof mr.description === "string" ? mr.description : ""),
        author: clipText(mr.author?.username ?? mr.author?.name ?? "deleted user"),
        headBranch: mr.source_branch ?? "",
        baseBranch: mr.target_branch ?? "",
        baseSha: requireSha(mr.diff_refs?.base_sha ?? ""),
        headRepository: this.#detailHeadRepository(mr),
        labels: clipLabels(mr.labels),
        reviewers: reviewers.requested.flatMap((r) => (r.kind === "user" ? [r.login] : [])),
        reviewDecision: snapshot.reviewDecision,
        commits: commits.total ?? commits.commits.length,
        changedFiles: changed?.count ?? 0,
        relatedThreads: [],
        relatedThreadsTruncated: false,
      }),
    );
  }

  prCommits(number: number, before: string | undefined, headSha: string, signal: AbortSignal) {
    return this.conversation.commits(number, before, headSha, signal);
  }
  prReviewers(number: number, signal: AbortSignal) {
    return this.conversation.reviewers(number, signal);
  }
  async prActivity(number: number, page: number, signal: AbortSignal) {
    if (!Number.isInteger(page) || page < 1 || page > 20) throw new ForgeError("invalid_data");
    const mr = await this.conversation.mr(number, signal);
    const { conversation } = await import("./gitlab-conversation-records.ts");
    const events = conversation(
      await this.conversation.discussions(number, signal),
      requireSha(headOf(mr)),
    ).events;
    return {
      events: events.slice((page - 1) * 100, page * 100),
      ...(events.length > page * 100 ? { nextPage: page + 1 } : {}),
      truncated: false,
    };
  }

  /** The diff file count from one per_page=1 page's x-total, when GitLab hasn't counted yet;
   * undefined when that page doesn't carry a count (GitLab omits it for very large results). */
  async #diffCount(
    number: number,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<{ count: number; capped: boolean } | undefined> {
    const { headers } = await this.#get(
      `projects/${this.#project}/merge_requests/${number}/diffs?per_page=1&page=1`,
      signal,
      budget,
    );
    const header = headers["x-total"];
    const total = header === undefined || header.trim() === "" ? Number.NaN : Number(header);
    if (!Number.isInteger(total) || total < 0) return undefined;
    return { count: total, capped: false };
  }

  /** The MR, which must still be pinned to the requested head and base. */
  async #pinnedMr(
    number: number,
    pinned: { headSha: string; baseSha: string },
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<GitLabMr> {
    const { body } = await this.#get(
      `projects/${this.#project}/merge_requests/${number}`,
      signal,
      budget,
    );
    const parsed = Mr.safeParse(body);
    if (!parsed.success || parsed.data.iid !== number) throw new ForgeError("invalid_data");
    const head = parsed.data.diff_refs?.head_sha ?? "";
    const base = parsed.data.diff_refs?.base_sha ?? "";
    if (
      head.toLowerCase() !== pinned.headSha.toLowerCase() ||
      base.toLowerCase() !== pinned.baseSha.toLowerCase()
    )
      throw new ForgeError("head_moved");
    return parsed.data;
  }

  async prFiles(
    input: {
      number: number;
      page: number;
      headSha: string;
      baseSha: string;
      commit?: string | undefined;
      since?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<ForgePrFilesType> {
    ForgeFilePageInput.parse(input);
    const pinned = PinnedShas.parse(input);
    if (pinned.commit !== undefined || pinned.since !== undefined)
      throw new ForgeError("unsupported");
    this.#ref(input.number);
    const budget = new ReadBudget();
    // The MR's diff_refs pin the read before and after the page; one 25-file page of /diffs
    // (the /changes endpoint is deprecated since GitLab 15.7) is the only diff page read.
    const mr = await this.#pinnedMr(input.number, pinned, signal, budget);
    const { body, headers } = await this.#get(
      `projects/${this.#project}/merge_requests/${input.number}/diffs?per_page=25&page=${input.page}`,
      signal,
      budget,
    );
    const parsed = DiffPage.safeParse(body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    await this.#pinnedMr(input.number, pinned, signal, budget);
    const page = parsed.data.slice(0, 25).map((c) => changeFile(c));
    const total = Number(headers["x-total"]);
    const nextHeader = headers["x-next-page"]?.trim();
    const more =
      nextHeader !== undefined
        ? nextHeader !== ""
        : Number.isInteger(total)
          ? input.page * 25 < total
          : parsed.data.length === 25;
    const beyondCap = more && input.page * 25 >= 1000;
    return must(
      ForgePrFiles.safeParse({
        ref: this.#ref(input.number),
        baseSha: pinned.baseSha,
        headSha: pinned.headSha,
        files: page,
        ...(more && !beyondCap ? { nextPage: input.page + 1 } : {}),
        // GitLab's own "1000+" count means its diff stopped short of the whole change.
        truncated:
          changesCount(mr)?.capped === true ||
          beyondCap ||
          (Number.isInteger(total) && total > 1000) ||
          page.some((file) => file.truncated),
      }),
    );
  }

  async prCheckout(number: number, signal: AbortSignal) {
    this.#ref(number);
    const budget = new ReadBudget();
    const { body } = await this.#get(
      `projects/${this.#project}/merge_requests/${number}`,
      signal,
      budget,
    );
    const parsed = Mr.safeParse(body);
    if (!parsed.success || parsed.data.iid !== number) throw new ForgeError("invalid_data");
    const mr = parsed.data;
    const headSha = requireSha(headOf(mr));
    const baseSha = requireSha(mr.diff_refs?.base_sha ?? "");
    signal.throwIfAborted();
    return must(
      ForgePrCheckout.safeParse({
        ref: this.#ref(number),
        headSha,
        baseSha,
        headBranch: mr.source_branch ?? "",
        baseBranch: mr.target_branch ?? "",
        headRepository: await this.#checkoutHeadRepository(mr, signal, budget),
      }),
    );
  }
}
