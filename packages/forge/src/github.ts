import { GitHubLifecycle } from "./github-lifecycle.ts";
import { GitHubReviews } from "./github-reviews.ts";
import { GitHubBrowser } from "./github-browser.ts";
import type { ForgePrSearch } from "@ace/protocol/forge-browser";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";
import { replyIntent, replyCutoff, reconcileReply, type ReplyReceipts } from "./reply-receipts.ts";
import { z } from "zod";
import {
  ForgeRepository,
  ForgePrRef,
  ForgeCreatePrInput,
  ForgePrStatus,
} from "@ace/protocol/forge";
import type { Forge, ForgeBrowser, MergeMethod } from "./api.ts";
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
export class GitHubForge implements Forge, ForgeBrowser {
  readonly repository: ForgeRepository;
  readonly lifecycle: GitHubLifecycle;
  readonly reviews: GitHubReviews;
  readonly #api: GhApi;
  readonly revisions = new StatusRevisions();
  readonly #status = new GitHubStatusReader(this.revisions);
  readonly #root: string;
  readonly #browser: GitHubBrowser;
  readonly #replyReceipts: ReplyReceipts | undefined;
  constructor(options: {
    repository: ForgeRepository;
    runner: CommandRunner;
    command?: string;
    now: () => number;
    replyReceipts?: ReplyReceipts;
  }) {
    this.#replyReceipts = options.replyReceipts;
    this.repository = ForgeRepository.parse(options.repository);
    if (this.repository.forge !== "github" || this.repository.owner.includes("/"))
      throw new ForgeError("unsupported");
    this.#root = `repos/${this.repository.owner}/${this.repository.name}`;
    this.#api = new GhApi({ ...options, host: this.repository.host });
    this.#browser = new GitHubBrowser(this.#api, this.repository);
    this.lifecycle = new GitHubLifecycle(this.#api, this.repository);
    this.reviews = new GitHubReviews(this.#api, (number) => this.#ref(number));
  }
  #ref(number: number): ForgePrRef {
    return ForgePrRef.parse({ repository: this.repository, number });
  }
  async status(number: number, signal: AbortSignal): Promise<ForgePrStatus> {
    return this.#status.read(this.#api, this.#root, this.repository, number, signal);
  }
  async currentUser(signal: AbortSignal): Promise<string> {
    const response = await this.#api.request("user", signal);
    const parsed = z.object({ login: z.string().min(1).max(100) }).safeParse(response.body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    return parsed.data.login;
  }
  prActivity(number: number, page: number, signal: AbortSignal) {
    return this.#browser.activity(number, page, signal);
  }
  listPrs(query: ForgePrSearch, signal: AbortSignal) {
    return this.#browser.list(query, signal);
  }
  async prDetail(number: number, signal: AbortSignal) {
    return this.#browser.detail(await this.status(number, signal), signal);
  }
  prCommits(number: number, page: number, headSha: string, signal: AbortSignal) {
    return this.#browser.commits(number, page, headSha, signal);
  }
  prFiles(
    input: {
      number: number;
      page: number;
      headSha: string;
      baseSha: string;
      commit?: string | undefined;
    },
    signal: AbortSignal,
  ) {
    return this.#browser.files(input, signal);
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
    if (!parsed.success) throw new ForgeMutationOutcome({ dispatched: true });
    if (response.identityChanged) throw new ForgeMutationOutcome(this.#ref(parsed.data.number));
    return this.#ref(parsed.data.number);
  }
  async replyComment(
    number: number,
    commentId: number,
    body: string,
    signal: AbortSignal,
    observer?: MutationDispatch,
  ): Promise<void> {
    this.#ref(number);
    positive.parse(commentId);
    z.string().min(1).max(65_536).parse(body);
    const receipts = observer ? undefined : this.#replyReceipts;
    const intent = replyIntent(this.repository, number, commentId, body);
    const reconcile = async (receipt: NonNullable<ReturnType<ReplyReceipts["get"]>>) => {
      const id = await reconcileReply(
        this.#api,
        this.#root,
        receipt,
        { account: receipts?.account ?? "", body, commentId, number },
        signal,
      );
      receipts?.put(intent, id);
    };
    const receipt = receipts?.get(intent);
    if (receipt) return reconcile(receipt);
    if (receipts) {
      const before = await replyCutoff(this.#api, this.#root, number, signal);
      if (!receipts.reserve(intent, before)) {
        const pending = receipts.get(intent);
        if (!pending) throw new ForgeError("conflict");
        return reconcile(pending);
      }
    }
    const dispatch = observer ?? new MutationDispatch();
    let response: import("./http.ts").Page;
    try {
      response = await this.#api.request(
        `${this.#root}/pulls/${number}/comments/${commentId}/replies`,
        signal,
        { body },
        "POST",
        dispatch,
      );
    } catch (error) {
      if (!(error instanceof ForgeMutationOutcome)) receipts?.remove(intent);
      throw error;
    }

    const parsed = z.object({ id: positive }).safeParse(response.body);
    if (!parsed.success) throw new ForgeMutationOutcome({ id: null });
    receipts?.put(intent, parsed.data.id);
    if (response.identityChanged) throw new ForgeMutationOutcome({ id: parsed.data.id });
  }

  async requestReviews(
    number: number,
    reviewers: string[],
    signal: AbortSignal,
    dispatch = new MutationDispatch(),
  ): Promise<void> {
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
      "POST",
      dispatch,
    );
    if (
      !z
        .object({ requested_reviewers: z.array(z.object({ login: z.string() })).max(100) })
        .safeParse(response.body).success
    )
      throw new ForgeMutationOutcome({ dispatched: true });
    if (response.identityChanged) throw new ForgeMutationOutcome(response.body);
  }
  async merge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
    dispatch = new MutationDispatch(),
  ): Promise<void> {
    this.#ref(number);
    shaSchema.parse(headSha);
    mergeSchema.parse(method);
    const response = await this.#api.request(
      `${this.#root}/pulls/${number}/merge`,
      signal,
      { sha: headSha, merge_method: method },
      "PUT",
      dispatch,
    );
    const parsed = z.object({ merged: z.boolean() }).safeParse(response.body);
    if (!parsed.success) throw new ForgeMutationOutcome({ dispatched: true });
    if (!parsed.data.merged) {
      dispatch.reject();
      throw new ForgeError("conflict", undefined, false);
    }
    if (response.identityChanged) throw new ForgeMutationOutcome(parsed.data);
  }
  async enableAutoMerge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
    dispatch = new MutationDispatch(),
  ): Promise<void> {
    this.#ref(number);
    shaSchema.parse(headSha);
    mergeSchema.parse(method);
    const metadata = z
      .object({ node_id: z.string().min(1), head: z.object({ sha: shaSchema }) })
      .safeParse((await this.#api.request(`${this.#root}/pulls/${number}`, signal)).body);
    if (!metadata.success) throw new ForgeError("invalid_data");
    if (metadata.data.head.sha !== headSha) throw new ForgeError("conflict", undefined, false);
    const response = await this.#api.request(
      "graphql",
      signal,
      {
        query:
          "mutation($input:EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input:$input) { pullRequest { id } } }",
        variables: {
          input: {
            pullRequestId: metadata.data.node_id,
            expectedHeadOid: headSha,
            mergeMethod: method.toUpperCase(),
          },
        },
      },
      "POST",
      dispatch,
    );
    const acknowledgement = z
      .object({
        data: z.object({
          enablePullRequestAutoMerge: z.object({ pullRequest: z.object({ id: z.string() }) }),
        }),
      })
      .safeParse(response.body);
    if (
      !acknowledgement.success ||
      acknowledgement.data.data.enablePullRequestAutoMerge.pullRequest.id !== metadata.data.node_id
    )
      throw new ForgeMutationOutcome({ dispatched: true });
    if (response.identityChanged) throw new ForgeMutationOutcome({ number, headSha });
  }

  async logTail(jobId: number, signal: AbortSignal) {
    positive.parse(jobId);
    return this.#api.log(`${this.#root}/actions/jobs/${jobId}/logs`, signal);
  }
}
