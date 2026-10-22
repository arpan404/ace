import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import {
  ForgeCompare,
  ForgeRepoPrOptions,
  type ForgeBranch,
  type ForgeCompareHead,
} from "@ace/protocol/forge-new-pr";
import type { GhApi } from "./http.ts";
import { ForgeError, ForgeQueryRefused } from "./errors.ts";
import { ReadBudget } from "./read-budget.ts";
import { CommitRecord, FileRecord } from "./github-browser-schemas.ts";
import { restCommit, restFiles } from "./rest-records.ts";
import { branchPath } from "./github-lifecycle-writes.ts";

const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
/** Branch, label and people lists read at most this many pages of 100. */
const maxPages = 10;
/** Changed files per compare page. */
const filePage = 25;

const Branch = z.looseObject({
  name: z.string().min(1).max(256),
  commit: z.looseObject({ sha }),
});
const Label = z.looseObject({
  name: text,
  color: z.string().nullish(),
  description: text.nullish(),
});
const Person = z.looseObject({ login: z.string().regex(/^[\w-]+$/).max(100), avatar_url: text.optional() });
const Milestone = z.looseObject({
  number: z.number().int().positive(),
  title: text,
  state: z.enum(["open", "closed"]),
  due_on: text.nullable(),
});
const Compared = z.looseObject({
  status: z.enum(["ahead", "behind", "diverged", "identical"]),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  total_commits: z.number().int().nonnegative(),
  merge_base_commit: z.looseObject({ sha }),
  commits: z.array(CommitRecord).max(250),
  files: z.array(FileRecord).max(300).optional(),
});
const Templates = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequestTemplates: z
          .array(z.looseObject({ filename: text.nullish(), body: text.nullish() }))
          .max(100)
          .nullable(),
      })
      .nullable(),
  }),
});

function decode<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data;
}

/** What opening a pull request from any branch reads: branches, the template, options, a compare. */
export class GitHubNewPr {
  readonly #api: GhApi;
  readonly #repository: ForgeRepository;
  readonly #root: string;
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#repository = repository;
    this.#root = `repos/${repository.owner}/${repository.name}`;
  }
  /** Every page of a REST list up to the page cap; `truncated` when GitHub had more. */
  async #pages<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
    const budget = new ReadBudget();
    const items: T[] = [];
    let endpoint: string | undefined = path;
    let page = 0;
    for (; endpoint && page < maxPages; page++) {
      const response = await this.#api.request(endpoint, signal);
      budget.add(response.bytes);
      items.push(...decode(z.array(schema).max(100), response.body));
      endpoint = this.#api.next(response, path);
    }
    return { items, truncated: endpoint !== undefined };
  }
  /** This repository's branches, the default first, then by name. */
  async branches(
    defaultBranch: string,
    signal: AbortSignal,
  ): Promise<{ branches: ForgeBranch[]; truncated: boolean }> {
    const { items, truncated } = await this.#pages(
      `${this.#root}/branches?per_page=100`,
      Branch,
      signal,
    );
    const branches = items
      .map((branch) => ({ name: branch.name, sha: branch.commit.sha }))
      .toSorted((a, b) =>
        a.name === defaultBranch ? -1 : b.name === defaultBranch ? 1 : a.name.localeCompare(b.name),
      );
    return { branches, truncated };
  }
  /**
   * The repository's pull request template: the default one (`pull_request_template.md` in
   * the root, `.github` or `docs`) when there are several, else the only one; null for none.
   * A host without the field has none to offer.
   */
  async template(signal: AbortSignal): Promise<string | null> {
    let body: unknown;
    try {
      body = (
        await this.#api.request("graphql", signal, {
          query: `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequestTemplates{filename body}}}`,
          variables: { owner: this.#repository.owner, name: this.#repository.name },
        })
      ).body;
    } catch (error) {
      if (error instanceof ForgeQueryRefused) return null;
      throw error;
    }
    const templates = (decode(Templates, body).data.repository?.pullRequestTemplates ?? []).filter(
      (template) => template.body?.trim(),
    );
    const named = templates.find((template) =>
      /(^|\/)pull_request_template\.md$/i.test(template.filename ?? ""),
    );
    return (named ?? (templates.length === 1 ? templates[0] : undefined))?.body ?? null;
  }
  /** Labels, assignable people and open milestones, each list bounded. */
  async options(signal: AbortSignal) {
    const [labels, people, milestones] = await Promise.all([
      this.#pages(`${this.#root}/labels?per_page=100`, Label, signal),
      this.#pages(`${this.#root}/assignees?per_page=100`, Person, signal),
      this.#api.request(
        `${this.#root}/milestones?state=open&sort=due_on&direction=asc&per_page=100`,
        signal,
      ),
    ]);
    return ForgeRepoPrOptions.parse({
      labels: labels.items.slice(0, 500).map((label) => ({
        name: label.name,
        ...(label.color && /^[0-9a-fA-F]{6}$/.test(label.color) ? { color: label.color } : {}),
        description: label.description ?? "",
      })),
      assignable: people.items.slice(0, 500).map((person) => ({
        login: person.login,
        ...(person.avatar_url ? { avatarUrl: person.avatar_url } : {}),
      })),
      milestones: decode(z.array(Milestone).max(100), milestones.body).map((milestone) => ({
        number: milestone.number,
        title: milestone.title,
        state: milestone.state,
        dueOn: milestone.due_on,
      })),
      truncated: labels.truncated || people.truncated,
    });
  }
  /**
   * The commits and changed files a pull request from `head` into `base` would show. GitHub
   * answers at most 250 commits and 300 files; the rest show once the pull request exists.
   */
  async compare(
    base: string,
    head: ForgeCompareHead,
    page: number,
    signal: AbortSignal,
  ): Promise<ForgeCompare> {
    // A fork's branch is named `owner:branch`, as GitHub documents for comparisons.
    const headRef =
      head.owner.toLowerCase() === this.#repository.owner.toLowerCase()
        ? branchPath(head.branch)
        : `${head.owner}:${branchPath(head.branch)}`;
    const response = await this.#api.request(
      `${this.#root}/compare/${branchPath(base)}...${headRef}`,
      signal,
    );
    const compared = decode(Compared, response.body);
    const files = compared.files ?? [];
    const first = (page - 1) * filePage;
    const last = compared.commits.at(-1);
    return ForgeCompare.parse({
      base,
      head,
      status: compared.status,
      aheadBy: compared.ahead_by,
      behindBy: compared.behind_by,
      mergeBaseSha: compared.merge_base_commit.sha,
      headSha: last?.sha ?? compared.merge_base_commit.sha,
      commits: compared.commits.map(restCommit),
      totalCommits: compared.total_commits,
      files: restFiles(files.slice(first, first + filePage)),
      totalFiles: files.length,
      ...(first + filePage < files.length ? { nextPage: page + 1 } : {}),
      truncated: compared.total_commits > compared.commits.length || files.length >= 300,
    });
  }
}
