import { ForgeError, ForgeMutationOutcome, repositoryKey, type GitHubForge } from "@ace/forge";
import {
  ForgeHostedPrCreateCommand,
  type CommandResult,
  type ForgeCompareHead,
  type ForgeNewPrContext,
} from "@ace/protocol";
import { prCreateTarget } from "./pr-create-target.ts";
import type { WorkspaceForgeContext } from "./workspace-forge-context.ts";

/** How long reads reuse a checkout's resolved target (its remote and its fork parent). */
const targetReuseMs = 30_000;

type Target = Awaited<ReturnType<WorkspaceNewPr["resolveTarget"]>>;

/** One repository, by owner and name whatever their case. */
const same = (a: { owner: string; name: string }, b: { owner: string; name: string }) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** A head a PR from this checkout may come from: the target repository, or its fork. */
const headIn = (target: Target["target"], head: { owner: string; name: string }) =>
  same(head, target.repository) || (target.head !== undefined && same(head, target.head));

/**
 * A project's new pull request from any branch, with no thread: where it opens (a fork's
 * parent), its branches and template, and the create itself. The create shares the thread
 * path's lookup-then-open, so an open PR of the same head and base is returned, never doubled.
 */
export class WorkspaceNewPr {
  private ctx: WorkspaceForgeContext;
  /** Reads of one page (context, options, each compare page) share one resolved target. */
  private targets = new Map<string, { at: number; value: Promise<Target> }>();
  constructor(ctx: WorkspaceForgeContext) {
    this.ctx = ctx;
  }
  /** Where a PR from this checkout opens, read now: what every create uses. */
  private async resolveTarget(cwd: string) {
    const checkout = await this.ctx.backends.checkoutRepository(cwd);
    const pushed = await this.ctx.backends.backend(cwd, checkout.repository);
    const metadata = await pushed.repositoryMetadata(this.ctx.signal);
    const target = prCreateTarget(checkout.repository, metadata, {});
    const backend =
      repositoryKey(target.repository) === repositoryKey(checkout.repository)
        ? pushed
        : await this.ctx.backends.backend(cwd, target.repository);
    return { target, pushed, backend, headDefault: metadata.defaultBranch };
  }
  /** Forget every resolved target: the account or source control preferences changed. */
  clear(): void {
    this.targets.clear();
  }
  /** The target for reads, reused for a short while; a failed resolution is never reused. */
  private cachedTarget(cwd: string): Promise<Target> {
    const now = this.ctx.now();
    for (const [key, entry] of this.targets)
      if (now - entry.at >= targetReuseMs) this.targets.delete(key);
    const kept = this.targets.get(cwd);
    if (kept && now - kept.at < targetReuseMs) return kept.value;
    const value = this.resolveTarget(cwd);
    this.targets.set(cwd, { at: now, value });
    value.catch(() => {
      if (this.targets.get(cwd)?.value === value) this.targets.delete(cwd);
    });
    return value;
  }
  async context(cwd: string, signal: AbortSignal): Promise<ForgeNewPrContext> {
    const { target, pushed, backend, headDefault } = await this.cachedTarget(cwd);
    const fork = backend !== pushed;
    const [base, head, template] = await Promise.all([
      backend.branches(target.base, signal),
      fork ? pushed.branches(headDefault, signal) : undefined,
      backend.prTemplate(signal),
    ]);
    return {
      base: { repository: target.repository, defaultBranch: target.base, ...base },
      // A fork by GitHub's current name for it, which is what its PRs report.
      head: {
        repository: target.head
          ? { ...pushed.repository, owner: target.head.owner, name: target.head.name }
          : target.repository,
        ...(head ?? base),
      },
      template,
    };
  }
  /**
   * What a PR from `head` into `base` would show. Only a head a create would take: a branch of
   * the target repository, or of the fork this checkout pushes to.
   */
  async compare(
    cwd: string,
    input: { base: string; head: ForgeCompareHead; page: number; headSha?: string | undefined },
    signal: AbortSignal,
  ) {
    const { target, backend } = await this.cachedTarget(cwd);
    if (!headIn(target, input.head)) throw new Error("repository_mismatch");
    return backend.compare(input.base, input.head, input.page, signal, input.headSha);
  }
  /** The backend for the repository the new PR opens on, for its options and comparisons. */
  async targetBackend(cwd: string): Promise<GitHubForge> {
    return (await this.cachedTarget(cwd)).backend;
  }
  async create(
    input: unknown,
    cwd: string,
    allowed: () => boolean,
  ): Promise<Omit<CommandResult, "commandId">> {
    const p = ForgeHostedPrCreateCommand.parse(input);
    const signal = this.ctx.signal;
    const { target, backend } = await this.resolveTarget(cwd);
    if (repositoryKey(p.repository) !== repositoryKey(target.repository))
      throw new Error("repository_mismatch");
    // The branch lives in the pushed repository (a fork) or the target itself, by owner and
    // name: a fork may share its owner with its parent.
    if (!headIn(target, p.head)) throw new Error("repository_mismatch");
    // The fork the branch is in, or none when it is in the target repository itself.
    const head = target.head && same(p.head, target.head) ? target.head : undefined;
    if (!head && p.head.branch === p.base) throw new ForgeError("no_commits");
    const found = await backend.findPr(p.head.branch, p.base, signal, head);
    if (found) {
      // A create whose answer was lost, or one that raced another: the PR exists. What this
      // create asked for is added to it, never replacing what it already has.
      const incomplete = await this.addDetails(backend, found.number, p, allowed);
      return this.result(backend, found.number, {
        prExisting: true,
        ...(incomplete ? { code: "forge_pr_details_incomplete" } : {}),
      });
    }
    signal.throwIfAborted();
    if (!allowed()) return { ok: false, error: "forbidden" };
    let created;
    try {
      created = await backend.openPr(
        { branch: p.head.branch, base: p.base, title: p.title, body: p.body, draft: p.draft },
        signal,
        head,
      );
    } catch (error) {
      // GitHub may have opened it: the next attempt finds it rather than opening another.
      if (error instanceof ForgeMutationOutcome)
        return { ok: false, error: "forge_write_uncertain" };
      throw error;
    }
    // The pull request exists now. What follows only adds to it; a refusal is reported, and
    // nothing is sent again.
    const incomplete = await this.setDetails(backend, created.number, p, allowed);
    return this.result(
      backend,
      created.number,
      incomplete ? { code: "forge_pr_details_incomplete" } : {},
    );
  }
  /** Each write in turn; true when any was refused or not allowed. */
  private async attempt(
    allowed: () => boolean,
    writes: readonly (() => Promise<void>)[],
  ): Promise<boolean> {
    let incomplete = false;
    for (const write of writes)
      try {
        if (!allowed()) throw new Error("forbidden");
        await write();
      } catch {
        incomplete = true;
      }
    return incomplete;
  }
  /** A new PR's labels, assignees and milestone in one issue write, then its reviewers. */
  private setDetails(
    backend: GitHubForge,
    number: number,
    p: ForgeHostedPrCreateCommand,
    allowed: () => boolean,
  ): Promise<boolean> {
    const signal = this.ctx.signal;
    const fields = {
      ...(p.labels.length ? { labels: p.labels } : {}),
      ...(p.assignees.length ? { assignees: p.assignees } : {}),
      ...(p.milestone ? { milestone: p.milestone } : {}),
    };
    return this.attempt(allowed, [
      ...(Object.keys(fields).length ? [() => backend.setIssueFields(number, fields, signal)] : []),
      ...(p.reviewers.length ? [() => backend.requestReviews(number, p.reviewers, signal)] : []),
    ]);
  }
  /** The same details added to an existing PR: labels and assignees join what it has. */
  private addDetails(
    backend: GitHubForge,
    number: number,
    p: ForgeHostedPrCreateCommand,
    allowed: () => boolean,
  ): Promise<boolean> {
    const signal = this.ctx.signal;
    const milestone = p.milestone;
    return this.attempt(allowed, [
      // A milestone replaces the one it has, so it is only set on a PR that has none; one in
      // another milestone keeps it, and the create says so.
      ...(milestone === undefined
        ? []
        : [
            async () => {
              const current = await backend.prMilestone(number, signal);
              if (current === milestone) return;
              if (current !== null) throw new Error("milestone_kept");
              await backend.setIssueFields(number, { milestone }, signal);
            },
          ]),
      ...(p.labels.length || p.assignees.length
        ? [
            () =>
              backend.addIssueFields(number, { labels: p.labels, assignees: p.assignees }, signal),
          ]
        : []),
      ...(p.reviewers.length ? [() => backend.requestReviews(number, p.reviewers, signal)] : []),
    ]);
  }
  private async result(
    backend: GitHubForge,
    number: number,
    extra: { prExisting?: true; code?: string },
  ): Promise<Omit<CommandResult, "commandId">> {
    const pr = { repository: backend.repository, number };
    try {
      const status = await backend.status(number, this.ctx.signal);
      return { ok: true, pr, prStatus: status, ...extra };
    } catch {
      return { ok: true, pr, code: extra.code ?? "forge_status_unavailable", ...extra };
    }
  }
}
