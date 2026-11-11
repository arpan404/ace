import { prCreateText } from "./pr-create-text.ts";
import { z } from "zod";
import { ForgeRepository, ForgePrRef, ForgeCreatePrInput } from "@ace/protocol/forge";
import { ForgeBranchName } from "@ace/protocol/forge-new-pr";
import type { PrHead } from "./api.ts";
import type { ForgeRepositoryMetadata } from "./github-repository.ts";
import { GitLabApi, gitLabProjectPath } from "./gitlab-api.ts";
import { GitLabReader } from "./gitlab-reader.ts";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { decode } from "./gitlab-records.ts";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";
import { ReadBudget } from "./read-budget.ts";
import { writesUnder, type HostApiWrite } from "./read-only-api.ts";
import type { WriteDispatch } from "./write-dispatch.ts";
const Project = z.looseObject({
  id: z.number().int().positive(),
  path_with_namespace: z.string(),
  default_branch: z.string().min(1).max(256),
});
const Metadata = Project.extend({ forked_from_project: Project.nullable().optional() });
const Match = z.looseObject({
  iid: z.number().int().positive(),
  source_project_id: z.number().int().positive(),
  target_project_id: z.number().int().positive(),
  source_branch: z.string(),
  target_branch: z.string(),
  state: z.string(),
});
const OpenInput = z.object({
  branch: ForgeBranchName,
  base: ForgeBranchName,
  title: z.string().min(1).max(256),
  body: z.string().max(65_536),
  draft: z.boolean(),
  labels: z.array(z.string().min(1).max(256)).max(100).optional(),
});
/**
 * Opening an MR in `target`, posted to the project its branch is in: `target` itself, or the
 * `source` fork. Nothing else is admitted.
 */
export function gitLabCreationWrites(
  target: ForgeRepository,
  source?: Pick<ForgeRepository, "owner" | "name">,
): readonly HostApiWrite[] {
  return [target, ...(source ? [source] : [])].flatMap((project) =>
    writesUnder(gitLabProjectPath(project), [{ method: "POST", path: "/merge_requests" }]),
  );
}
const Branches = z
  .array(
    z.looseObject({
      name: ForgeBranchName,
      commit: z.looseObject({ id: z.string().regex(/^[a-fA-F0-9]{40,64}$/) }),
    }),
  )
  .max(100);
const MatchPage = z.array(Match).max(100);

/** The project an MR's branch is in: `repository` itself, or the `head` fork. */
function sourceRepository(repository: ForgeRepository, head: PrHead | undefined): ForgeRepository {
  if (
    !head ||
    `${head.owner}/${head.name}`.toLowerCase() ===
      `${repository.owner}/${repository.name}`.toLowerCase()
  )
    return repository;
  return ForgeRepository.parse({ ...repository, ...head });
}

/** The caller owns primary/head selection and visibility. This adapter proves project IDs. */
export class GitLabCreation {
  readonly repository: ForgeRepository;
  readonly #api: GitLabApi;
  readonly #reader: GitLabReader;
  constructor(options: { repository: ForgeRepository; runner: CommandRunner }) {
    this.#api = new GitLabApi(options);
    this.repository = this.#api.repository;
    this.#reader = new GitLabReader(options);
  }
  status(number: number, signal: AbortSignal) {
    return this.#reader.status(number, signal);
  }
  async repositoryMetadata(signal: AbortSignal): Promise<ForgeRepositoryMetadata> {
    const record = decode(
      Metadata,
      (await this.#api.get(this.#api.root, signal, new ReadBudget())).body,
    );
    const locate = (project: z.infer<typeof Project>) => {
      const slash = project.path_with_namespace.lastIndexOf("/");
      if (slash <= 0) throw new ForgeError("invalid_data");
      return ForgeRepository.parse({
        ...this.repository,
        owner: project.path_with_namespace.slice(0, slash),
        name: project.path_with_namespace.slice(slash + 1),
      });
    };
    const parent = record.forked_from_project;
    return {
      repository: locate(record),
      defaultBranch: record.default_branch,
      parent: parent ? { repository: locate(parent), defaultBranch: parent.default_branch } : null,
    };
  }
  async branches(_defaultBranch: string, signal: AbortSignal) {
    const budget = new ReadBudget();
    const branches: { name: string; sha: string }[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await this.#api.get(
        `${this.#api.root}/repository/branches?per_page=100&page=${page}`,
        signal,
        budget,
      );
      const rows = decode(Branches, response.body);
      branches.push(...rows.map((row) => ({ name: row.name, sha: row.commit.id })));
      const next = response.headers["x-next-page"];
      if (next?.trim() === "" || (next === undefined && rows.length < 100))
        return { branches, truncated: false };
    }
    return { branches, truncated: true };
  }
  async #projects(head: PrHead | undefined, signal: AbortSignal, budget: ReadBudget) {
    const source = sourceRepository(this.repository, head);
    const target = decode(Project, (await this.#api.get(this.#api.root, signal, budget)).body);
    if (source === this.repository) return { target, source: target };
    const fork = decode(
      Metadata,
      (await this.#api.get(gitLabProjectPath(source), signal, budget)).body,
    );
    if (fork.forked_from_project?.id !== target.id) throw new ForgeError("conflict");
    return { target, source: fork };
  }
  async findPr(
    branch: string,
    base: string,
    signal: AbortSignal,
    head?: PrHead,
  ): Promise<ForgePrRef | null> {
    ForgeBranchName.parse(branch);
    ForgeBranchName.parse(base);
    const budget = new ReadBudget();
    const { target, source } = await this.#projects(head, signal, budget);
    const params = new URLSearchParams({
      state: "opened",
      source_branch: branch,
      target_branch: base,
      per_page: "100",
    });
    const response = await this.#api.get(
      `${this.#api.root}/merge_requests?${params}`,
      signal,
      budget,
    );
    const rows = decode(MatchPage, response.body);
    // An incomplete lookup cannot prove absence, so never proceed to create.
    if (
      response.headers["x-next-page"]?.trim() ||
      (response.headers["x-next-page"] === undefined && rows.length === 100)
    )
      throw new ForgeError("limit");
    const matching = rows.filter(
      (row) =>
        row.state === "opened" &&
        row.source_project_id === source.id &&
        row.target_project_id === target.id &&
        row.source_branch === branch &&
        row.target_branch === base,
    );
    if (matching.length > 1) throw new ForgeError("conflict");
    return matching[0]
      ? ForgePrRef.parse({ repository: this.repository, number: matching[0].iid })
      : null;
  }
  async openPr(
    raw: z.infer<typeof OpenInput>,
    signal: AbortSignal,
    head?: PrHead,
    dispatch: WriteDispatch = new MutationDispatch(),
  ): Promise<ForgePrRef> {
    const input = OpenInput.parse(raw);
    if (input.labels?.some((label) => label.includes(","))) throw new ForgeError("unprocessable");
    const budget = new ReadBudget();
    const { target, source } = await this.#projects(head, signal, budget);
    if (source.id === target.id && input.branch === input.base) throw new ForgeError("no_commits");
    let response;
    try {
      // Posted to the source project by path, the one admission pins; its id was checked above.
      response = await this.#api.write(
        `${gitLabProjectPath(sourceRepository(this.repository, head))}/merge_requests`,
        "POST",
        {
          source_branch: input.branch,
          target_branch: input.base,
          target_project_id: target.id,
          title:
            input.draft && !/^Draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title,
          description: input.body,
          ...(input.labels?.length ? { labels: input.labels.join(",") } : {}),
        },
        signal,
        budget,
        dispatch,
      );
    } catch (error) {
      throw dispatch.failure(error);
    }
    const ack = Match.safeParse(response.body);
    if (
      !ack.success ||
      ack.data.source_project_id !== source.id ||
      ack.data.target_project_id !== target.id ||
      ack.data.source_branch !== input.branch ||
      ack.data.target_branch !== input.base
    )
      throw new ForgeMutationOutcome({ dispatched: true });
    return ForgePrRef.parse({ repository: this.repository, number: ack.data.iid });
  }
  async createPr(
    threadId: string,
    raw: ForgeCreatePrInput,
    signal: AbortSignal,
    head?: PrHead,
  ): Promise<ForgePrRef> {
    return this.openPr(prCreateText(threadId, raw), signal, head);
  }
}
