import { ForgeError, repositoryKey, prFromUrl, prUrl, prRepository } from "@ace/forge";
import {
  ForgePrRef,
  type ForgePrStatus,
  type ThreadId,
  type ForgeRepository,
  type AgentControlResult,
} from "@ace/protocol";
import type { PrOwnerOperation } from "./agent-control/tools.ts";
import type { WorkspaceForgeContext } from "./workspace-forge-context.ts";
import { pullRequestFollow } from "./pull-request-follow.ts";

/** A thread's PR associations: link, unlink, agent tools, status and batched refresh. */
export class WorkspacePrAssociations {
  private ctx: WorkspaceForgeContext;
  constructor(ctx: WorkspaceForgeContext) {
    this.ctx = ctx;
  }
  async link(
    id: ThreadId,
    cwd: string,
    input: ForgePrRef,
    permitted: () => boolean = () => true,
    signal: AbortSignal = this.ctx.signal,
  ): Promise<ForgePrStatus> {
    const check = await this.ctx.sourceControl?.guard();
    const allowed = () => {
      check?.();
      return permitted();
    };
    const pr = ForgePrRef.parse(input);
    signal.throwIfAborted();
    if (!allowed()) throw new Error("forbidden");
    const revision = this.ctx.owner.capture(pr);
    const existing = this.ctx.links.getLinkState(id, pr);
    if (existing) {
      try {
        const status = await (
          await this.ctx.backends.backend(cwd, pr.repository)
        ).status(pr.number, signal);
        signal.throwIfAborted();
        if (!allowed()) throw new Error("forbidden");
        if (this.ctx.owner.current(pr, revision))
          this.ctx.projection.update(id, status, existing.generation);
        return status;
      } catch (error) {
        signal.throwIfAborted();
        if (!allowed()) throw new Error("forbidden", { cause: error });
        if (
          error instanceof ForgeError &&
          error.kind === "not_found" &&
          this.ctx.owner.current(pr, revision)
        )
          this.ctx.projection.deleted(id, pr, existing.generation);
        else if (
          error instanceof ForgeError &&
          !["cli", "offline", "forbidden", "rate_limit"].includes(error.kind)
        )
          throw error;
        return this.ctx.projection.fallback(
          pr,
          this.ctx.links
            .summaries(id)
            .find(
              (item) =>
                item.number === pr.number &&
                repositoryKey(item.repo) === repositoryKey(pr.repository),
            ),
        );
      }
    }
    let status: ForgePrStatus;
    try {
      status = await (
        await this.ctx.backends.backend(cwd, pr.repository)
      ).status(pr.number, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof ForgeError &&
        !["cli", "offline", "forbidden", "rate_limit"].includes(error.kind)
      )
        throw error;
      status = this.ctx.projection.fallback(pr);
    }
    signal.throwIfAborted();
    if (!allowed()) throw new Error("forbidden");
    const thread = this.ctx.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    this.ctx.store.atomic(() => {
      // Another caller may have linked it while validation was in flight.
      if (this.ctx.links.getLinkState(id, pr)) return;
      this.ctx.links.link({ threadId: id, pr });
      const generation = this.ctx.links.getLinkState(id, pr)?.generation;
      if (status.state === "unknown" && generation !== undefined)
        this.ctx.links.update(
          id,
          {
            number: pr.number,
            repo: pr.repository,
            url: prUrl(pr),
            state: "open",
            updatedAt: this.ctx.now(),
            unverified: true,
          },
          generation,
        );
      else if (this.ctx.owner.current(pr, revision))
        this.ctx.projection.update(id, status, generation);
      this.ctx.projection.publish(id);
    });
    return status;
  }
  unlink(id: ThreadId, pr?: ForgePrRef): void {
    this.ctx.store.atomic(() => {
      this.ctx.links.unlink(id, pr);
      this.ctx.projection.publish(id);
    });
  }
  async agent(
    id: ThreadId,
    cwd: string,
    operation: PrOwnerOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult> {
    if (operation.op === "thread.list_prs")
      return { ok: true, data: { linkedPrs: this.ctx.links.summaries(id) } };
    if (operation.op === "thread.unlink_pr" && operation.all) {
      signal.throwIfAborted();
      this.unlink(id);
      return { ok: true, data: { all: true, linkedPrs: [] } };
    }
    try {
      // A bare `owner/name` lives on this checkout's host (an Enterprise host, say), never
      // an assumed github.com.
      const origin = operation.url
        ? undefined
        : "repo" in operation && operation.repo
          ? prRepository(operation.repo, await this.defaultRepositoryHost(cwd))
          : await this.ctx.backends.repository(cwd);
      const pr = operation.url
        ? prFromUrl(
            operation.url,
            (await this.ctx.sourceControl?.preferences())?.hosts.map((entry) => entry.host),
          )
        : ForgePrRef.parse({
            number: operation.number,
            repository:
              origin && "repo" in operation && operation.repo
                ? prRepository(operation.repo, origin)
                : origin,
          });
      if (operation.op === "thread.link_pr") {
        if (!this.ctx.links.getLinkState(id, pr))
          await this.link(id, cwd, pr, () => !signal.aborted, signal);
      } else {
        signal.throwIfAborted();
        this.unlink(id, pr);
      }
      return { ok: true, data: { number: pr.number, linkedPrs: this.ctx.links.summaries(id) } };
    } catch (error) {
      signal.throwIfAborted();
      return {
        ok: false,
        code: error instanceof ForgeError && error.kind === "not_found" ? "not_found" : "invalid",
      };
    }
  }
  /** The checkout's repository, else the configured host, as a fallback for `owner/name`. */
  private async defaultRepositoryHost(cwd: string): Promise<ForgeRepository> {
    try {
      return await this.ctx.backends.repository(cwd);
    } catch {
      const host = (await this.ctx.sourceControl?.preferences())?.host ?? "github.com";
      return { forge: "github", host, owner: "unused", name: "unused" };
    }
  }
  async status(id: ThreadId, cwd: string): Promise<ForgePrStatus | null> {
    const check = await this.ctx.sourceControl?.guard();
    const state = this.ctx.links.getLinkState(id);
    if (!state) return null;
    const { link, generation } = state;
    const revision = this.ctx.owner.capture(link.pr);
    try {
      const status = await (
        await this.ctx.backends.backend(cwd, link.pr.repository)
      ).status(link.pr.number, this.ctx.signal);
      await this.ctx.store.write(() => {
        check?.();
        if (this.ctx.owner.current(link.pr, revision))
          this.ctx.projection.update(id, status, generation);
      });
      return status;
    } catch (error) {
      check?.();
      if (error instanceof ForgeError && error.kind === "not_found") {
        await this.ctx.store.write(() => {
          check?.();
          if (this.ctx.owner.current(link.pr, revision))
            this.ctx.projection.deleted(id, link.pr, generation);
        });
        return this.ctx.projection.fallback(
          link.pr,
          this.ctx.links.summaries(id).find((pr) => pr.number === link.pr.number),
        );
      }
      throw error;
    }
  }
  /**
   * Each sweep batches lightweight state reads per repository, at most 100 refs per request.
   * A merged or deleted PR cannot change again, so it is left out and costs no GitHub budget.
   */
  async refresh(threads: readonly { id: ThreadId; cwd: string }[]): Promise<void> {
    const groups = new Map<
      string,
      {
        cwd: string;
        repo: ForgeRepository;
        entries: { id: ThreadId; pr: ForgePrRef; generation: number }[];
      }
    >();
    for (const thread of threads) {
      const final = new Set(
        this.ctx.links
          .summaries(thread.id)
          .filter((pr) => pullRequestFollow(pr) === "final")
          .map((pr) => `${repositoryKey(pr.repo)}#${pr.number}`),
      );
      for (const { link, generation } of this.ctx.links.getLinks(thread.id)) {
        const key = repositoryKey(link.pr.repository);
        if (final.has(`${key}#${link.pr.number}`)) continue;
        let group = groups.get(key);
        if (!group) {
          group = { cwd: thread.cwd, repo: link.pr.repository, entries: [] };
          groups.set(key, group);
        }
        group.entries.push({ id: thread.id, pr: link.pr, generation });
      }
    }
    let failure: unknown;
    for (const group of groups.values()) {
      try {
        const check = await this.ctx.sourceControl?.guard();
        const backend = await this.ctx.backends.backend(group.cwd, group.repo);
        const numbers = [...new Set(group.entries.map((entry) => entry.pr.number))];
        if (!backend.states) continue;
        for (let offset = 0; offset < numbers.length; offset += 100) {
          const batch = numbers.slice(offset, offset + 100);
          const revisions = new Map(
            batch.map((number) => [
              number,
              this.ctx.owner.capture({ repository: group.repo, number }),
            ]),
          );
          const summaries = await backend.states(batch, this.ctx.signal);
          // Ownership and generation checks run inside the same commit as the projection.
          await this.ctx.store.write(() => {
            check?.();
            for (const entry of group.entries) {
              const revision = revisions.get(entry.pr.number);
              if (!revision || !this.ctx.owner.current(entry.pr, revision)) continue;
              const summary = summaries.get(entry.pr.number);
              if (summary === null)
                this.ctx.projection.deleted(entry.id, entry.pr, entry.generation);
              else if (
                summary &&
                this.ctx.links.getLinkState(entry.id, entry.pr)?.generation === entry.generation
              ) {
                this.ctx.links.update(entry.id, summary, entry.generation);
                this.ctx.projection.publish(entry.id);
              }
            }
          });
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}
