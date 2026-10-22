import { ForgeError, ForgeMutationOutcome, repositoryKey, type GitHubForge } from "@ace/forge";
import {
  ForgeHostedPrCreateCommand,
  type CommandResult,
  type ForgeNewPrContext,
} from "@ace/protocol";
import { prCreateTarget } from "./pr-create-target.ts";
import type { WorkspaceForgeContext } from "./workspace-forge-context.ts";

/**
 * A project's new pull request from any branch, with no thread: where it opens (a fork's
 * parent), its branches and template, and the create itself. The create shares the thread
 * path's lookup-then-open, so an open PR of the same head and base is returned, never doubled.
 */
export class WorkspaceNewPr {
  private ctx: WorkspaceForgeContext;
  constructor(ctx: WorkspaceForgeContext) {
    this.ctx = ctx;
  }
  private async target(cwd: string) {
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
  async context(cwd: string, signal: AbortSignal): Promise<ForgeNewPrContext> {
    const { target, pushed, backend, headDefault } = await this.target(cwd);
    const fork = backend !== pushed;
    const [base, head, template] = await Promise.all([
      backend.branches(target.base, signal),
      fork ? pushed.branches(headDefault, signal) : undefined,
      backend.prTemplate(signal),
    ]);
    return {
      base: { repository: target.repository, defaultBranch: target.base, ...base },
      head: { repository: pushed.repository, ...(head ?? base) },
      template,
    };
  }
  /** The backend for the repository the new PR opens on, for its options and comparisons. */
  async targetBackend(cwd: string): Promise<GitHubForge> {
    return (await this.target(cwd)).backend;
  }
  async create(
    input: unknown,
    cwd: string,
    allowed: () => boolean,
  ): Promise<Omit<CommandResult, "commandId">> {
    const p = ForgeHostedPrCreateCommand.parse(input);
    const signal = this.ctx.signal;
    const { target, backend } = await this.target(cwd);
    if (repositoryKey(p.repository) !== repositoryKey(target.repository))
      throw new Error("repository_mismatch");
    // The branch lives in the pushed repository (a fork) or the target itself.
    const owners = [target.headOwner, target.repository.owner].map((owner) => owner.toLowerCase());
    if (!owners.includes(p.head.owner.toLowerCase())) throw new Error("repository_mismatch");
    if (
      p.head.owner.toLowerCase() === target.repository.owner.toLowerCase() &&
      p.head.branch === p.base
    )
      throw new ForgeError("no_commits");
    const found = await backend.findPr(p.head.branch, p.base, signal, p.head.owner);
    if (found) return this.result(backend, found.number, { prExisting: true });
    signal.throwIfAborted();
    if (!allowed()) return { ok: false, error: "forbidden" };
    let created;
    try {
      created = await backend.openPr(
        { branch: p.head.branch, base: p.base, title: p.title, body: p.body, draft: p.draft },
        signal,
        p.head.owner,
      );
    } catch (error) {
      // GitHub may have opened it: the next attempt finds it rather than opening another.
      if (error instanceof ForgeMutationOutcome)
        return { ok: false, error: "forge_write_uncertain" };
      throw error;
    }
    // The pull request exists now. What follows only adds to it; a refusal is reported, and
    // nothing is sent again.
    let incomplete = false;
    const fields = {
      ...(p.labels.length ? { labels: p.labels } : {}),
      ...(p.assignees.length ? { assignees: p.assignees } : {}),
      ...(p.milestone ? { milestone: p.milestone } : {}),
    };
    if (Object.keys(fields).length)
      try {
        if (!allowed()) throw new Error("forbidden");
        await backend.setIssueFields(created.number, fields, signal);
      } catch {
        incomplete = true;
      }
    if (p.reviewers.length)
      try {
        if (!allowed()) throw new Error("forbidden");
        await backend.requestReviews(created.number, p.reviewers, signal);
      } catch {
        incomplete = true;
      }
    return this.result(
      backend,
      created.number,
      incomplete ? { code: "forge_pr_details_incomplete" } : {},
    );
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
