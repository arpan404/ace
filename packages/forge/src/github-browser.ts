import { prIndicatorFields, prIndicators } from "./github-browser-enrichment.ts";
import { z } from "zod";
import { ForgePrRef, type ForgeRepository, type ForgePrStatus } from "@ace/protocol/forge";
import {
  ForgePrSearch,
  ForgePageInput,
  ForgePrFiles,
  type ForgePrList,
  type ForgePrDetail,
  type ForgeCommit,
} from "@ace/protocol/forge-browser";
import {
  BrowserPr,
  SearchPage,
  CommitRecord,
  FileRecord,
  CommitFiles,
} from "./github-browser-schemas.ts";
import { ForgeError } from "./errors.ts";
import { TimelinePage, timelineActivity } from "./github-activity.ts";
import type { GhApi } from "./http.ts";

const stateQuery = {
  open: "is:open draft:false",
  draft: "is:open draft:true",
  closed: "is:closed is:unmerged",
  merged: "is:merged",
  active: "is:open",
};
/** The states a list counts: each PR falls in exactly one. */
const countedStates = ["open", "draft", "closed", "merged"] as const;
/** Literal words cannot change repository scope through GitHub search qualifiers. */
export function prSearchQuery(repository: ForgeRepository, query: ForgePrSearch): string {
  return [
    `repo:${repository.owner}/${repository.name}`,
    "is:pr",
    stateQuery[query.state],
    ...query.search
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => JSON.stringify(word)),
    ...(query.author ? [`author:${query.author}`] : []),
    ...(query.reviewer ? [`review-requested:${query.reviewer}`] : []),
    // GitHub's combined status of the head commit, check runs included.
    ...(query.ci === "failure" ? ["status:failure"] : []),
  ].join(" ");
}
const Counts = z.object({
  data: z.object({
    open: z.object({ issueCount: z.number().int().nonnegative() }),
    draft: z.object({ issueCount: z.number().int().nonnegative() }),
    closed: z.object({ issueCount: z.number().int().nonnegative() }),
    merged: z.object({ issueCount: z.number().int().nonnegative() }),
  }),
});
const Decision = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewDecision: z.string().max(100).nullable(),
        headRefOid: z.string(),
        files: z.unknown().optional(),
      }),
    }),
  }),
});
const DetailFiles = z.object({
  nodes: z
    .array(
      z.object({
        path: z.string().max(65_536),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        changeType: z.string().max(100),
      }),
    )
    .max(100),
});
/** GraphQL's change types in the REST file statuses `ForgeFile.status` uses. */
const fileStatuses: Partial<Record<string, string>> = { DELETED: "removed" };
const CommitStatistics = z.object({
  data: z.object({
    repository: z.record(
      z.string(),
      z
        .looseObject({
          oid: z.string(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
        })
        .nullable(),
    ),
  }),
});
function decode<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data;
}
export class GitHubBrowser {
  readonly #api: GhApi;
  readonly #repository: ForgeRepository;
  readonly #root: string;
  readonly #mergeBases = new Map<string, string>();
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#repository = repository;
    this.#root = `repos/${repository.owner}/${repository.name}`;
  }
  async activity(number: number, page: number, signal: AbortSignal) {
    ForgePrRef.parse({ repository: this.#repository, number });
    ForgePageInput.parse({ page });
    const path = `${this.#root}/issues/${number}/timeline?per_page=25&page=${page}`;
    const response = await this.#api.request(path, signal);
    const records = decode(TimelinePage, response.body);
    const next = this.#api.next(response, path);
    return {
      events: records.map((record, index) => timelineActivity(record, page, index)),
      ...(next && page < 120 ? { nextPage: page + 1 } : {}),
      truncated: Boolean(next && page === 120),
    };
  }
  async list(input: ForgePrSearch, signal: AbortSignal): Promise<ForgePrList> {
    const query = ForgePrSearch.parse(input);
    const params = new URLSearchParams({
      q: prSearchQuery(this.#repository, query),
      sort: query.sort,
      order: query.order,
      per_page: "25",
      page: String(query.page),
    });
    const page = decode(
      SearchPage,
      (await this.#api.request(`search/issues?${params}`, signal)).body,
    );
    const fields = countedStates.map((state) => {
      const selected = ForgePrSearch.parse({ ...query, state });
      return `${state}: search(type: ISSUE, query: ${JSON.stringify(prSearchQuery(this.#repository, selected))}, first: 1) { issueCount }`;
    });
    const response = await this.#api.request("graphql", signal, {
      query: `query { ${fields.join(" ")} ${prIndicatorFields(
        this.#repository,
        page.items.map((item) => item.number),
      )} }`,
    });
    const counts = decode(Counts, response.body).data;
    const indicators = prIndicators(response.body);
    return {
      repository: this.#repository,
      items: page.items.map((item, index) =>
        Object.assign({}, indicators[`p${index}`], {
          raw: { search: item, indicators: indicators[`p${index}`]?.raw },
          ref: { repository: this.#repository, number: item.number },
          title: item.title,
          url: item.html_url,
          author: item.user?.login ?? "deleted user",
          authorAvatarUrl: item.user?.avatar_url,
          commentCount: indicators[`p${index}`]?.commentCount ?? item.comments,
          labels: item.labels.map((l) => l.name),
          updatedAt: item.updated_at,
          state: item.pull_request.merged_at
            ? "merged"
            : item.state === "closed"
              ? "closed"
              : item.draft
                ? "draft"
                : "open",
        }),
      ),
      total: page.total_count,
      counts: {
        open: counts.open.issueCount,
        draft: counts.draft.issueCount,
        closed: counts.closed.issueCount,
        merged: counts.merged.issueCount,
      },
      ...(query.page * 25 < Math.min(page.total_count, 1000) ? { nextPage: query.page + 1 } : {}),
      incomplete: page.incomplete_results,
      truncated: page.total_count > 1000,
    };
  }
  /**
   * A PR's detail. Its status and review decision are independent reads, so they run at
   * once; both must name the same head, else a push landed between them and the read is retried.
   */
  async detail(
    number: number,
    status: (signal: AbortSignal) => Promise<ForgePrStatus>,
    signal: AbortSignal,
  ): Promise<ForgePrDetail> {
    for (let attempt = 0; ; attempt++) {
      const reads = [status(signal), this.#decision(number, signal)] as const;
      await Promise.allSettled(reads);
      const [current, decision] = await Promise.all(reads);
      if (decision.headRefOid === current.headSha) return this.#detail(current, decision);
      if (attempt > 0) throw new ForgeError("conflict");
    }
  }
  async #decision(number: number, signal: AbortSignal) {
    const { owner, name } = this.#repository;
    return decode(
      Decision,
      (
        await this.#api.request("graphql", signal, {
          query: `query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewDecision headRefOid files(first:100) { nodes { path additions deletions changeType } } } } }`,
          variables: { owner, name, number },
        })
      ).body,
    ).data.repository.pullRequest;
  }
  #detail(
    status: ForgePrStatus,
    decision: z.infer<typeof Decision>["data"]["repository"]["pullRequest"],
  ): ForgePrDetail {
    const raw = decode(z.object({ pr: BrowserPr }), status.raw).pr;
    const files = DetailFiles.safeParse(decision.files);
    return {
      status,
      updatedAt: raw.updated_at,
      createdAt: raw.created_at,
      additions: raw.additions,
      deletions: raw.deletions,
      authorAvatarUrl: raw.user?.avatar_url,
      reviewerAvatars: Object.fromEntries(
        raw.requested_reviewers.flatMap((u) => (u.avatar_url ? [[u.login, u.avatar_url]] : [])),
      ),
      body: raw.body ?? "",
      author: raw.user?.login ?? "deleted user",
      headBranch: raw.head.ref,
      baseBranch: raw.base.ref,
      baseSha: raw.base.sha,
      headRepository: raw.head.repo
        ? { ...this.#repository, owner: raw.head.repo.owner.login, name: raw.head.repo.name }
        : null,
      labels: raw.labels.map((l) => l.name),
      reviewers: raw.requested_reviewers.map((u) => u.login),
      reviewDecision: decision.reviewDecision,
      commits: raw.commits,
      changedFiles: raw.changed_files,
      ...(files.success
        ? {
            files: files.data.nodes.map((node) => ({
              path: node.path,
              additions: node.additions,
              deletions: node.deletions,
              status: fileStatuses[node.changeType] ?? node.changeType.toLowerCase(),
            })),
          }
        : {}),
      relatedThreads: [],
      relatedThreadsTruncated: false,
    };
  }
  async #head(number: number, headSha: string, baseSha: string | undefined, signal: AbortSignal) {
    ForgePrRef.parse({ repository: this.#repository, number });
    const raw = decode(
      BrowserPr,
      (await this.#api.request(`${this.#root}/pulls/${number}`, signal)).body,
    );
    if (
      raw.number !== number ||
      raw.head.sha !== headSha ||
      (baseSha !== undefined && raw.base.sha !== baseSha)
    )
      throw new ForgeError("conflict");
    return raw;
  }
  async commits(number: number, page: number, headSha: string, signal: AbortSignal) {
    ForgePageInput.parse({ page });
    ForgePrRef.parse({ repository: this.#repository, number });
    const path = `${this.#root}/pulls/${number}/commits?per_page=25&page=${page}`;
    const response = await this.#api.request(path, signal);
    const items = decode(z.array(CommitRecord).max(25), response.body);
    const commits: ForgeCommit[] = items.map((item) => ({
      raw: item,
      sha: item.sha,
      message: item.commit.message,
      author: item.author?.login ?? item.commit.author?.name ?? "deleted user",
      authorAvatarUrl: item.author?.avatar_url,
      date: item.commit.author?.date ?? null,
      url: item.html_url,
    }));
    // Statistics are per commit, so they never depend on the head: they are read beside the
    // revalidation that proves the list still belongs to the head the caller asked for.
    const reads = [
      this.#head(number, headSha, undefined, signal),
      this.#commitStatistics(commits, signal),
    ] as const;
    await Promise.allSettled(reads);
    const [raw, stats] = await Promise.all(reads);
    commits.forEach((commit, i) => {
      const stat = stats?.[`c${i}`];
      if (stat) commit.raw = { commit: commit.raw, statistics: stat };
      if (stat?.oid === commit.sha) {
        commit.additions = stat.additions;
        commit.deletions = stat.deletions;
      }
    });
    return {
      commits,
      ...(this.#api.next(response, path) && page < 10 ? { nextPage: page + 1 } : {}),
      truncated: raw.commits > 250,
    };
  }
  /** Where two commits' histories meet: fixed for the pair, so a pair is asked for once. */
  async #mergeBase(base: string, head: string, signal: AbortSignal): Promise<string> {
    const key = `${base}...${head}`;
    const known = this.#mergeBases.get(key);
    if (known) return known;
    const comparison = decode(
      z.looseObject({
        merge_base_commit: z.looseObject({ sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/) }),
      }),
      (await this.#api.request(`${this.#root}/compare/${key}`, signal)).body,
    );
    const sha = comparison.merge_base_commit.sha;
    this.#mergeBases.set(key, sha);
    if (this.#mergeBases.size > 128) {
      const oldest = this.#mergeBases.keys().next().value;
      if (oldest !== undefined) this.#mergeBases.delete(oldest);
    }
    return sha;
  }
  /** One bounded GraphQL batch supplies statistics absent from REST's commit list. */
  async #commitStatistics(commits: readonly ForgeCommit[], signal: AbortSignal) {
    if (!commits.length) return undefined;
    const fields = commits.map(
      (c, i) =>
        `c${i}: object(oid: ${JSON.stringify(c.sha)}) { ... on Commit { oid additions deletions } }`,
    );
    return decode(
      CommitStatistics,
      (
        await this.#api.request("graphql", signal, {
          query: `query { repository(owner:${JSON.stringify(this.#repository.owner)}, name:${JSON.stringify(this.#repository.name)}) { ${fields.join(" ")} } }`,
        })
      ).body,
    ).data.repository;
  }
  async files(
    input: {
      number: number;
      page: number;
      headSha: string;
      baseSha: string;
      commit?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<ForgePrFiles> {
    const parsed = ForgePrFiles.pick({ headSha: true, baseSha: true, commit: true }).parse(input);
    ForgePageInput.parse(input);
    ForgePrRef.parse({ repository: this.#repository, number: input.number });
    // The merge base is named by two commits, so it is read beside the files, never after.
    const mergeBase = parsed.commit
      ? undefined
      : this.#mergeBase(parsed.baseSha, parsed.headSha, signal);
    // Handled here: it may fail while the files are still being read.
    void mergeBase?.catch(() => undefined);
    try {
      return await this.#files(input, parsed, signal, mergeBase);
    } finally {
      // No read outlives the call, even one whose answer an earlier failure made moot.
      await mergeBase?.catch(() => undefined);
    }
  }
  async #files(
    input: { number: number; page: number },
    parsed: { headSha: string; baseSha: string; commit?: string | undefined },
    signal: AbortSignal,
    mergeBase: Promise<string> | undefined,
  ): Promise<ForgePrFiles> {
    let path = `${this.#root}/pulls/${input.number}/files?per_page=25&page=${input.page}`;
    let baseSha = parsed.baseSha;
    let headSha = parsed.headSha;
    if (parsed.commit) {
      // A URL cannot select an unrelated repository commit as a PR commit.
      let found = false;
      for (let page = 1; page <= 3 && !found; page++) {
        const commitsPath = `${this.#root}/pulls/${input.number}/commits?per_page=100&page=${page}`;
        const response = await this.#api.request(commitsPath, signal);
        found = decode(z.array(CommitRecord).max(100), response.body).some(
          (c) => c.sha === parsed.commit,
        );
        if (!this.#api.next(response, commitsPath)) break;
      }
      if (!found) throw new ForgeError("not_found");
      path = `${this.#root}/commits/${parsed.commit}?per_page=25&page=${input.page}`;
      headSha = parsed.commit;
    }
    const response = await this.#api.request(path, signal);
    let records;
    if (parsed.commit) {
      const commit = decode(CommitFiles, response.body);
      if (commit.sha !== parsed.commit) throw new ForgeError("invalid_data");
      const parent = commit.parents[0];
      if (!parent) throw new ForgeError("unsupported");
      baseSha = parent.sha;
      records = commit.files;
    } else records = decode(z.array(FileRecord).max(25), response.body);
    let remaining = 262_144;
    const files = records.map((file) => {
      const patch = file.patch === undefined ? null : file.patch.slice(0, remaining);
      remaining -= patch?.length ?? 0;
      return {
        raw: Object.assign({}, file, { patch }),
        path: file.filename,
        previousPath: file.previous_filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch,
        truncated: patch === null || patch.length < (file.patch?.length ?? 0),
      };
    });
    const next = this.#api.next(response, path);
    const [comparison] = await Promise.allSettled([mergeBase]);
    // Revalidate after the reads, so a moved head never labels old data as current. A moved
    // head or base also explains a failed comparison, so it is reported first.
    const pr = await this.#head(input.number, parsed.headSha, parsed.baseSha, signal);
    if (comparison.status === "rejected") throw comparison.reason;
    if (comparison.value !== undefined) baseSha = comparison.value;
    return {
      ref: { repository: this.#repository, number: input.number },
      baseSha,
      headSha,
      ...(parsed.commit ? { commit: parsed.commit } : {}),
      files,
      ...(next && input.page < 120 ? { nextPage: input.page + 1 } : {}),
      truncated:
        (!parsed.commit && pr.changed_files > 3000) ||
        Boolean(next && input.page === 120) ||
        files.some((f) => f.truncated),
    };
  }
}
