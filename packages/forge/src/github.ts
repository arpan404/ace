import { z } from "zod";
import {
  ForgeRepository,
  ForgePrRef,
  ForgeCreatePrInput,
  ForgePrStatus,
} from "@ace/protocol/forge";
import type { Forge, MergeMethod } from "./api.ts";
import { StatusRevisions } from "./revisions.ts";
import { GitHubStatusReader } from "./github-status.ts";
import { GhApi } from "./http.ts";
import { GitHubPr } from "./github-schemas.ts";
import { ForgeError } from "./errors.ts";
import type { CommandRunner } from "./command.ts";
import { githubStates } from "./github-states.ts";

const positive = z.number().int().positive();
const shaSchema = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const mergeSchema = z.enum(["merge", "squash", "rebase"]);
export class GitHubForge implements Forge {
  readonly repository: ForgeRepository;
  readonly #api: GhApi;
  readonly revisions = new StatusRevisions();
  readonly #status = new GitHubStatusReader(this.revisions);
  readonly #root: string;
  constructor(options: {
    repository: ForgeRepository;
    runner: CommandRunner;
    command?: string;
    now: () => number;
  }) {
    this.repository = ForgeRepository.parse(options.repository);
    if (this.repository.forge !== "github" || this.repository.owner.includes("/"))
      throw new ForgeError("unsupported");
    this.#root = `repos/${this.repository.owner}/${this.repository.name}`;
    this.#api = new GhApi({ ...options, host: this.repository.host });
  }
  #ref(number: number): ForgePrRef {
    return ForgePrRef.parse({ repository: this.repository, number });
  }
  async status(number: number, signal: AbortSignal): Promise<ForgePrStatus> {
    return this.#status.read(this.#api, this.#root, this.repository, number, signal);
  }
  async states(numbers: readonly number[], signal: AbortSignal) {
    return githubStates(this.#api, this.repository, numbers, signal);
  }
  async findPr(branch: string, base: string, signal: AbortSignal): Promise<ForgePrRef | null> {
    z.string().min(1).max(256).parse(branch);
    z.string().min(1).max(256).parse(base);
    // GitHub documents head as owner:branch. All states prevent recreating a closed PR.
    const query = new URLSearchParams({
      state: "all",
      head: `${this.repository.owner}:${branch}`,
      base,
      per_page: "2",
    });
    const response = await this.#api.request(`${this.#root}/pulls?${query}`, signal);
    const results = z
      .array(GitHubPr.extend({ base: z.looseObject({ ref: z.string().max(256) }) }))
      .max(2)
      .safeParse(response.body);
    if (!results.success) throw new ForgeError("invalid_data");
    if (results.data.length > 1) throw new ForgeError("conflict");
    const found = results.data[0];
    if (found && (found.head.ref !== branch || found.base.ref !== base))
      throw new ForgeError("invalid_data");
    return found ? this.#ref(found.number) : null;
  }
  async createPr(
    threadId: string,
    input: ForgeCreatePrInput,
    signal: AbortSignal,
  ): Promise<ForgePrRef> {
    const value = ForgeCreatePrInput.parse(input);
    const fields: Record<string, string> = {
      threadId: z.string().min(1).max(256).parse(threadId),
      branch: value.branch,
      title: value.title,
      summary: value.summary,
    };
    const render = (template: string) =>
      template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        const field = fields[key];
        if (!Object.hasOwn(fields, key) || field === undefined)
          throw new ForgeError("invalid_data");
        return field;
      });
    const title = z.string().min(1).max(256).parse(render(value.template.title));
    const body = z.string().max(65_536).parse(render(value.template.body));
    const response = await this.#api.request(`${this.#root}/pulls`, signal, {
      head: value.branch,
      base: value.base,
      title,
      body,
      draft: value.draft,
    });
    const parsed = GitHubPr.safeParse(response.body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    return this.#ref(parsed.data.number);
  }
  async replyComment(
    number: number,
    commentId: number,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.#ref(number);
    positive.parse(commentId);
    z.string().min(1).max(65_536).parse(body);
    const response = await this.#api.request(
      `${this.#root}/pulls/${number}/comments/${commentId}/replies`,
      signal,
      { body },
    );
    if (!z.object({ id: positive }).safeParse(response.body).success)
      throw new ForgeError("invalid_data");
  }
  async requestReviews(number: number, reviewers: string[], signal: AbortSignal): Promise<void> {
    this.#ref(number);
    const names = z
      .array(z.string().regex(/^[\w-]+$/))
      .min(1)
      .max(100)
      .parse(reviewers);
    const response = await this.#api.request(
      `${this.#root}/pulls/${number}/requested_reviewers`,
      signal,
      { reviewers: names },
    );
    if (
      !z
        .object({ requested_reviewers: z.array(z.object({ login: z.string() })).max(100) })
        .safeParse(response.body).success
    )
      throw new ForgeError("invalid_data");
  }
  async merge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
  ): Promise<void> {
    this.#ref(number);
    shaSchema.parse(headSha);
    mergeSchema.parse(method);
    const response = await this.#api.request(
      `${this.#root}/pulls/${number}/merge`,
      signal,
      { sha: headSha, merge_method: method },
      "PUT",
    );
    const parsed = z.object({ merged: z.boolean() }).safeParse(response.body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    if (!parsed.data.merged) throw new ForgeError("conflict");
  }
  async enableAutoMerge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
  ): Promise<void> {
    this.#ref(number);
    shaSchema.parse(headSha);
    mergeSchema.parse(method);
    await this.#api.autoMerge(
      `${this.repository.host}/${this.repository.owner}/${this.repository.name}`,
      number,
      headSha,
      method,
      signal,
    );
  }
  async logTail(jobId: number, signal: AbortSignal) {
    positive.parse(jobId);
    return this.#api.log(`${this.#root}/actions/jobs/${jobId}/logs`, signal);
  }
}
