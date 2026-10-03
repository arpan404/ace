import {
  GitHubForge,
  ForgeStore,
  repositoryFromRemote,
  type CommandRunner,
  type Forge,
} from "@ace/forge";
import {
  ForgeCommand,
  type ForgePrStatus,
  type CommandResult,
  ThreadId,
  ForgeCreatePrInput,
} from "@ace/protocol";
import type { GitService } from "@ace/git";
import type { Store } from "./store.ts";

export class WorkspaceForge {
  private store: Store;
  private git: Pick<GitService, "repositoryInfo">;
  private now: () => number;
  private runner: (cwd: string) => CommandRunner;
  private links: ForgeStore;
  private backends = new Map<string, Forge>();
  private lifetime = new AbortController();
  constructor(
    store: Store,
    git: Pick<GitService, "repositoryInfo">,
    now: () => number,
    runner: (cwd: string) => CommandRunner,
  ) {
    this.store = store;
    this.git = git;
    this.now = now;
    this.runner = runner;
    this.links = store.atomic((db) => new ForgeStore(db));
  }
  private async backend(cwd: string): Promise<Forge> {
    const info = await this.git.repositoryInfo(cwd);
    const remote = (info.remotes.find((entry) => entry.name === "origin") ?? info.remotes[0])
      ?.fetchUrls[0];
    const repository = repositoryFromRemote(remote);
    const key = JSON.stringify({ repository, cwd });
    let backend = this.backends.get(key);
    if (!backend)
      backend = new GitHubForge({
        repository,
        runner: this.runner(cwd),
        now: this.now,
      });
    this.backends.delete(key);
    this.backends.set(key, backend);
    if (this.backends.size > 32) {
      const first = this.backends.keys().next().value;
      if (first !== undefined) this.backends.delete(first);
    }
    return backend;
  }
  private publish(id: ThreadId, status: ForgePrStatus): void {
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined || status.state === "unknown") return;
    const linkedPr = {
      number: status.ref.number,
      state: status.state === "draft" ? ("open" as const) : status.state,
      url: status.url,
    };
    if (JSON.stringify(thread.details?.linkedPr) === JSON.stringify(linkedPr)) return;
    this.store.appendEvents(
      id,
      [{ type: "thread.client.updated", changes: { details: { ...thread.details, linkedPr } } }],
      this.now(),
    );
  }
  async status(id: ThreadId, cwd: string): Promise<ForgePrStatus | null> {
    const link = this.links.getLink(id);
    if (!link) return null;
    const backend = await this.backend(cwd);
    if (JSON.stringify(link.pr.repository) !== JSON.stringify(backend.repository))
      throw new Error("repository_mismatch");
    const status = await backend.status(link.pr.number, this.lifetime.signal);
    this.publish(ThreadId.parse(id), status);
    return status;
  }
  /** Host-owned unique branches make remote lookup a durable create receipt. */
  async ensurePr(
    id: ThreadId,
    cwd: string,
    input: ForgeCreatePrInput,
    allowed: () => boolean,
  ): Promise<ForgePrStatus> {
    const value = ForgeCreatePrInput.parse(input);
    const backend = await this.backend(cwd);
    if (!allowed()) throw new Error("forbidden");
    const linked = this.links.getLink(id);
    if (linked && JSON.stringify(linked.pr.repository) !== JSON.stringify(backend.repository))
      throw new Error("repository_mismatch");
    if (!backend.findPr) throw new Error("forge_recovery_unavailable");
    const found = await backend.findPr(value.branch, value.base, this.lifetime.signal);
    if (linked && linked.pr.number !== found?.number) throw new Error("pr_link_changed");
    if (!allowed()) throw new Error("forbidden");
    const pr = found ?? (await backend.createPr(id, value, this.lifetime.signal));
    if (!allowed()) throw new Error("forbidden");
    this.links.link({ threadId: id, pr });
    const status = await backend.status(pr.number, this.lifetime.signal);
    this.publish(id, status);
    return status;
  }
  async execute(
    input: unknown,
    cwd: string,
    allowed: () => boolean,
  ): Promise<Omit<CommandResult, "commandId">> {
    const p = ForgeCommand.parse(input);
    const id = "threadId" in p ? p.threadId : p.link.threadId;
    const backend = await this.backend(cwd);
    const repository = "repository" in p ? p.repository : p.link.pr.repository;
    if (JSON.stringify(repository) !== JSON.stringify(backend.repository))
      throw new Error("repository_mismatch");
    if (!allowed()) return { ok: false, error: "forbidden" };
    if (p.type === "forge.pr.create") {
      const pr = await backend.createPr(id, p.input, this.lifetime.signal);
      this.links.link({ threadId: id, pr });
      const status = await backend.status(pr.number, this.lifetime.signal);
      this.publish(ThreadId.parse(id), status);
      return { ok: true, pr };
    }
    if (p.type === "forge.pr.link") {
      const status = await backend.status(p.link.pr.number, this.lifetime.signal);
      if (!allowed()) return { ok: false, error: "forbidden" };
      this.links.link(p.link);
      this.publish(ThreadId.parse(id), status);
      return { ok: true, pr: p.link.pr, prStatus: status };
    }
    if (p.type === "forge.pr.status") {
      const status = await backend.status(p.link.pr.number, this.lifetime.signal);
      this.publish(ThreadId.parse(id), status);
      return { ok: true, prStatus: status };
    }
    if (p.type === "forge.comment.reply")
      await backend.replyComment(p.link.pr.number, p.commentId, p.body, this.lifetime.signal);
    if (p.type === "forge.review.request")
      await backend.requestReviews(p.link.pr.number, p.reviewers, this.lifetime.signal);
    if (p.type === "forge.pr.merge")
      await backend.merge(p.link.pr.number, p.headSha, p.method, this.lifetime.signal);
    if (p.type === "forge.pr.auto-merge")
      await backend.enableAutoMerge(p.link.pr.number, p.headSha, p.method, this.lifetime.signal);
    return { ok: true };
  }
  close(): void {
    this.lifetime.abort();
    this.backends.clear();
  }
}
