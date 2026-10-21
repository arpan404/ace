import { ForgePrCheckout } from "@ace/protocol/forge-worktree";
import { BrowserPr } from "./github-browser-schemas.ts";
import { GitHubLifecycle } from "./github-lifecycle.ts";
import type { WriteDispatch } from "./write-dispatch.ts";
import { GitHubIssues } from "./github-issues.ts";
import { ForgeIssueSearch, type ForgeIssueWrite } from "@ace/protocol/forge-issues";
import { GitHubMergeState } from "./github-merge-state.ts";
import { sameStack } from "./stack-plan.ts";
import { GitHubStacks } from "./github-stacks.ts";
import { LocalStacks } from "./local-stacks.ts";
import type { StackPublisher } from "./stack-publish.ts";
import { ForgeStackExpected } from "@ace/protocol/forge-stacks";
import { GitHubReviews } from "./github-reviews.ts";
import { GitHubChecks } from "./github-checks.ts";
import { GitHubBrowser } from "./github-browser.ts";
import { ForgePrSearch } from "@ace/protocol/forge-browser";
import { ForgeListCaches } from "./list-cache.ts";
import { githubOpenWork } from "./github-open-work.ts";
import { ForgeMutationOutcome, MutationDispatch, uncertainWriteExpired } from "./mutation.ts";
import { githubRepositoryMetadata } from "./github-repository.ts";
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
  /** Check runs opened in the PR panel, and their re-runs. */
  readonly checks: GitHubChecks;
  readonly #api: GhApi;
  readonly revisions = new StatusRevisions();
  readonly #status = new GitHubStatusReader(this.revisions);
  readonly #root: string;
  readonly #browser: GitHubBrowser;
  readonly #issues: GitHubIssues;
  readonly #mergeState: GitHubMergeState;
  readonly #stacks: GitHubStacks;
  readonly #localStacks: LocalStacks;
  readonly #replyReceipts: ReplyReceipts | undefined;
  readonly #now: () => number;
  readonly #lists: ForgeListCaches;
  constructor(options: {
    repository: ForgeRepository;
    runner: CommandRunner;
    command?: string;
    now: () => number;
    replyReceipts?: ReplyReceipts;
    /** Publishes rebased stack layers with one atomic leased push in the task checkout. */
    publishStack?: StackPublisher;
    /** Open PR and issue lists, shared with other backends for the same repository and identity. */
    lists?: ForgeListCaches;
  }) {
    this.#replyReceipts = options.replyReceipts;
    this.#now = options.now;
    this.repository = ForgeRepository.parse(options.repository);
    if (this.repository.forge !== "github" || this.repository.owner.includes("/"))
      throw new ForgeError("unsupported");
    this.#root = `repos/${this.repository.owner}/${this.repository.name}`;
    const lists = options.lists ?? new ForgeListCaches(options.now);
    this.#lists = lists;
    this.#api = new GhApi({
      ...options,
      host: this.repository.host,
      onWrite: () => lists.invalidate(),
    });
    this.#mergeState = new GitHubMergeState(this.#api, this.repository);
    this.#stacks = new GitHubStacks(this.#api, this.repository);
    this.#localStacks = new LocalStacks(options.runner, options.command, options.publishStack);
    this.#browser = new GitHubBrowser(this.#api, this.repository);
    this.lifecycle = new GitHubLifecycle(this.#api, this.repository);
    this.reviews = new GitHubReviews(this.#api, (number) => this.#ref(number));
    this.checks = new GitHubChecks(this.#api, this.repository);
    this.#issues = new GitHubIssues(this.#api, this.repository);
  }
  listIssues(query: ForgeIssueSearch, signal: AbortSignal) {
    const parsed = ForgeIssueSearch.parse(query);
    return this.#lists.issues.read(JSON.stringify(parsed), signal, (shared) =>
      this.#issues.list(parsed, shared),
    );
  }
  issueDetail(number: number, signal: AbortSignal) {
    return this.#issues.detail(number, signal);
  }
  issueTimeline(number: number, page: number, signal: AbortSignal) {
    return this.#issues.timeline(number, page, signal);
  }
  writeIssue(
    input: ForgeIssueWrite,
    actionId: string,
    signal: AbortSignal,
    dispatch?: WriteDispatch,
  ) {
    return this.#issues.write(input, actionId, signal, dispatch);
  }
  reconcileIssue(input: ForgeIssueWrite, actionId: string, signal: AbortSignal) {
    return this.#issues.reconcile(input, actionId, signal);
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
  async prCheckout(number: number, signal: AbortSignal): Promise<ForgePrCheckout> {
    this.#ref(number);
    const parsed = BrowserPr.safeParse(
      (await this.#api.request(`${this.#root}/pulls/${number}`, signal)).body,
    );
    if (!parsed.success || parsed.data.number !== number) throw new ForgeError("invalid_data");
    const pr = parsed.data;
    const sourceRepository = pr.head.repo
      ? ForgeRepository.safeParse({
          ...this.repository,
          owner: pr.head.repo.owner.login,
          name: pr.head.repo.name,
        })
      : undefined;
    if (sourceRepository && !sourceRepository.success) throw new ForgeError("invalid_data");
    const headRepository = sourceRepository?.success ? sourceRepository.data : null;
    if (headRepository) {
      const source = `repos/${headRepository.owner}/${headRepository.name}/git/ref/heads/${encodeURIComponent(pr.head.ref)}`;
      let head: import("./http.ts").Page;
      try {
        head = await this.#api.request(source, signal);
      } catch (error) {
        // The PR exists but its head branch was deleted from the source repository.
        if (error instanceof ForgeError && error.kind === "not_found")
          throw new ForgeError("head_missing");
        throw error;
      }
      const branch = z.object({ object: z.object({ sha: shaSchema }) }).safeParse(head.body);
      if (!branch.success) throw new ForgeError("invalid_data");
      if (branch.data.object.sha !== pr.head.sha) throw new ForgeError("head_moved");
    }
    signal.throwIfAborted();
    return ForgePrCheckout.parse({
      ref: this.#ref(number),
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      headRepository,
    });
  }
  prMergeState(number: number, signal: AbortSignal) {
    return this.#mergeState.read(number, signal);
  }
  changeMergeState(
    number: number,
    headSha: string,
    action: "enable" | "disable" | "dequeue",
    method: MergeMethod,
    signal: AbortSignal,
    allowed: () => boolean = () => true,
    dispatch?: WriteDispatch,
  ) {
    return this.#mergeState.change(number, headSha, action, method, signal, allowed, dispatch);
  }
  prStack(number: number, signal: AbortSignal) {
    return this.#stacks.read(number, signal);
  }
  stackMemberships(numbers: readonly number[], signal: AbortSignal) {
    return this.#stacks.memberships(numbers, signal);
  }
  stackMergeScope(numbers: readonly number[], signal: AbortSignal) {
    return this.#stacks.mergeScope(numbers, signal);
  }
  localStack(signal: AbortSignal) {
    return this.#localStacks.read(signal);
  }
  mergeStack(
    number: number,
    expected: ForgeStackExpected,
    method: MergeMethod,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch?: WriteDispatch,
  ) {
    return this.#stacks.merge(number, expected, method, signal, allowed, dispatch);
  }
  stackMergeResult(number: number, uuid: string, signal: AbortSignal) {
    return this.#stacks.mergeResult(number, uuid, signal);
  }
  async rebaseStack(
    number: number,
    expected: ForgeStackExpected,
    action: "rebase" | "continue" | "abort" | "push",
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch?: WriteDispatch,
  ) {
    const revisions = ForgeStackExpected.parse(expected);
    const stack = await this.#stacks.read(number, signal);
    if (!stack || !sameStack(revisions, stack)) throw new ForgeError("conflict");
    return this.#localStacks.rebase(action, revisions, stack, signal, allowed, dispatch);
  }
  /** Restack the layers above the checked-out one, or continue or abort that restack. */
  restackStack(
    step: "upstack" | "continue" | "abort",
    signal: AbortSignal,
    allowed: () => boolean,
  ) {
    return this.#localStacks.restack(step, signal, allowed);
  }
  prActivity(number: number, page: number, signal: AbortSignal) {
    return this.#browser.activity(number, page, signal);
  }
  listPrs(query: ForgePrSearch, signal: AbortSignal) {
    const parsed = ForgePrSearch.parse(query);
    return this.#lists.prs.read(JSON.stringify(parsed), signal, (shared) =>
      this.#browser.list(parsed, shared),
    );
  }
  openWork(signal: AbortSignal) {
    return this.#lists.openWork.read("open", signal, (shared) =>
      githubOpenWork(this.#api, this.repository, shared),
    );
  }
  async prDetail(number: number, signal: AbortSignal) {
    this.#ref(number);
    return this.#browser.detail(number, (scope) => this.status(number, scope), signal);
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
  /** The host's default branch and fork parent for this repository. */
  repositoryMetadata(signal: AbortSignal) {
    return githubRepositoryMetadata(this.#api, this.repository, signal);
  }
  /**
   * The open PR from `headOwner:branch` into `base` in this repository, if any. Merged and
   * closed PRs are history: a new create is allowed once they are done. GitHub refuses a
   * second open PR for the same head and base, so an open match also recovers an in-flight
   * create whose acknowledgement was lost.
   */
  async findPr(
    branch: string,
    base: string,
    signal: AbortSignal,
    headOwner = this.repository.owner,
  ): Promise<ForgePrRef | null> {
    z.string().min(1).max(256).parse(branch);
    z.string().min(1).max(256).parse(base);
    z.string().min(1).max(100).parse(headOwner);
    // GitHub documents head as owner:branch, which also names a fork's branch.
    const query = new URLSearchParams({
      state: "open",
      head: `${headOwner}:${branch}`,
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
  /** `headOwner` names a fork that holds the branch when this repository is its parent. */
  async createPr(
    threadId: string,
    input: ForgeCreatePrInput,
    signal: AbortSignal,
    headOwner = this.repository.owner,
  ): Promise<ForgePrRef> {
    const value = ForgeCreatePrInput.parse(input);
    if (value.base === undefined) throw new ForgeError("base_missing");
    z.string().min(1).max(100).parse(headOwner);
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
      head: headOwner === this.repository.owner ? value.branch : `${headOwner}:${value.branch}`,
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
    /** True when the earlier reply is confirmed; false when it provably never landed. */
    const reconcile = async (receipt: NonNullable<ReturnType<ReplyReceipts["get"]>>) => {
      const id = await reconcileReply(
        this.#api,
        this.#root,
        receipt,
        { account: receipts?.account ?? "", body, commentId, number },
        signal,
      );
      if (id !== null) {
        receipts?.put(intent, id);
        return true;
      }
      // GitHub may still be converging. Past the window, a complete read without the reply
      // proves it never landed (or was deleted), so the same text may be sent again.
      if (!uncertainWriteExpired(receipt.at, this.#now()))
        throw new ForgeMutationOutcome({ id: receipt.id });
      receipts?.remove(intent);
      return false;
    };
    const receipt = receipts?.get(intent);
    if (receipt && (await reconcile(receipt))) return;
    if (receipts) {
      const before = await replyCutoff(this.#api, this.#root, number, signal);
      if (!receipts.reserve(intent, before, this.#now())) {
        const pending = receipts.get(intent);
        if (!pending) throw new ForgeError("conflict");
        if (await reconcile(pending)) return;
        // Another caller reserved the same reply meanwhile; never send it twice.
        throw new ForgeMutationOutcome({ id: pending.id });
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
    await this.#mergeState.change(number, headSha, "enable", method, signal, () => true, dispatch);
  }

  async logTail(jobId: number, signal: AbortSignal) {
    positive.parse(jobId);
    return this.#api.log(`${this.#root}/actions/jobs/${jobId}/logs`, signal);
  }
}
