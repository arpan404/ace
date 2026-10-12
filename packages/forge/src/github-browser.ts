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
import type { GhApi } from "./http.ts";

const stateQuery = {
  open: "is:open draft:false",
  draft: "is:open draft:true",
  closed: "is:closed is:unmerged",
  merged: "is:merged",
};
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
      }),
    }),
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
    const records = decode(
      z
        .array(
          z.looseObject({
            id: z.union([z.string(), z.number()]).optional(),
            node_id: z.string().optional(),
            event: z.string().max(256),
            actor: z
              .looseObject({ login: z.string().max(256), avatar_url: z.string().optional() })
              .nullable()
              .optional(),
            created_at: z.string().nullable().optional(),
            sha: z.string().optional(),
            submitted_at: z.string().nullable().optional(),
            label: z.looseObject({ name: z.string() }).optional(),
            requested_reviewer: z.looseObject({ login: z.string() }).nullable().optional(),
          }),
        )
        .max(25),
      response.body,
    );
    const next = this.#api.next(response, path);
    return {
      events: records.map((record, index) =>
        Object.assign(
          {
            id: String(record.id ?? record.node_id ?? `${page}:${index}`),
            event: record.event,
            actor: record.actor?.login ?? "GitHub",
            at: record.created_at ?? record.submitted_at ?? null,
            actorAvatarUrl: record.actor?.avatar_url,
            subject: record.label?.name ?? record.requested_reviewer?.login,
            raw: record,
          },
          record.sha && /^[a-fA-F0-9]{40,64}$/.test(record.sha) ? { commitSha: record.sha } : {},
        ),
      ),
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
    const fields = Object.keys(stateQuery).map((state) => {
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
  async detail(status: ForgePrStatus, signal: AbortSignal): Promise<ForgePrDetail> {
    const raw = decode(z.object({ pr: BrowserPr }), status.raw).pr;
    const { owner, name } = this.#repository;
    const decision = decode(
      Decision,
      (
        await this.#api.request("graphql", signal, {
          query: `query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewDecision headRefOid } } }`,
          variables: { owner, name, number: status.ref.number },
        })
      ).body,
    ).data.repository.pullRequest;
    if (decision.headRefOid !== status.headSha) throw new ForgeError("conflict");
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
    const raw = await this.#head(number, headSha, undefined, signal);
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
    // One bounded GraphQL batch supplies statistics absent from REST's commit list.
    if (commits.length) {
      const fields = commits.map(
        (c, i) =>
          `c${i}: object(oid: ${JSON.stringify(c.sha)}) { ... on Commit { oid additions deletions } }`,
      );
      const stats = decode(
        z.object({
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
        }),
        (
          await this.#api.request("graphql", signal, {
            query: `query { repository(owner:${JSON.stringify(this.#repository.owner)}, name:${JSON.stringify(this.#repository.name)}) { ${fields.join(" ")} } }`,
          })
        ).body,
      ).data.repository;
      commits.forEach((commit, i) => {
        const stat = stats[`c${i}`];
        if (stat) commit.raw = { commit: commit.raw, statistics: stat };
        if (stat?.oid === commit.sha) {
          commit.additions = stat.additions;
          commit.deletions = stat.deletions;
        }
      });
    }
    await this.#head(number, headSha, undefined, signal);
    return {
      commits,
      ...(this.#api.next(response, path) && page < 10 ? { nextPage: page + 1 } : {}),
      truncated: raw.commits > 250,
    };
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
    const pr = await this.#head(input.number, parsed.headSha, parsed.baseSha, signal);
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
    if (!parsed.commit) {
      const comparison = decode(
        z.looseObject({
          merge_base_commit: z.looseObject({ sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/) }),
        }),
        (
          await this.#api.request(
            `${this.#root}/compare/${parsed.baseSha}...${parsed.headSha}`,
            signal,
          )
        ).body,
      );
      baseSha = comparison.merge_base_commit.sha;
    }
    const next = this.#api.next(response, path);
    // Revalidate after long reads, so a moved head never labels old data as current.
    await this.#head(input.number, parsed.headSha, parsed.baseSha, signal);
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
