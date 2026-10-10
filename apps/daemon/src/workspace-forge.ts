import {
  GitHubForge,
  ForgeError,
  repositoryFromRemote,
  repositoryKey,
  prFromUrl,
  prUrl,
  prRepository,
  type CommandRunner,
  type Forge,
} from "@ace/forge";
import {
  ForgeCommand,
  ForgePrRef,
  type ForgePrStatus,
  type CommandResult,
  ThreadId,
  ForgeCreatePrInput,
  type ForgeRepository,
  type AgentControlResult,
} from "@ace/protocol";
import type { GitService } from "@ace/git";
import type { Store } from "./store.ts";
import { WorkspacePrLinks } from "./workspace-pr-links.ts";
import type { PrOwnerOperation } from "./agent-control/tools.ts";

export class WorkspaceForge {
  private store: Store;
  private git: Pick<GitService, "repositoryInfo">;
  private now: () => number;
  private runner: (cwd: string) => CommandRunner;
  private projection: WorkspacePrLinks;
  private links: WorkspacePrLinks["links"];
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
    this.projection = new WorkspacePrLinks(store, now);
    this.links = this.projection.links;
  }
  async repository(cwd: string): Promise<ForgeRepository> {
    const info = await this.git.repositoryInfo(cwd);
    const remote = (info.remotes.find((entry) => entry.name === "origin") ?? info.remotes[0])
      ?.fetchUrls[0];
    return repositoryFromRemote(remote);
  }
  private backend(cwd: string, repository: ForgeRepository): Forge {
    const key = JSON.stringify({ repository, cwd });
    let backend = this.backends.get(key);
    if (!backend)
      backend = new GitHubForge({ repository, runner: this.runner(cwd), now: this.now });
    this.backends.delete(key);
    this.backends.set(key, backend);
    if (this.backends.size > 32) {
      const first = this.backends.keys().next().value;
      if (first !== undefined) this.backends.delete(first);
    }
    return backend;
  }
  async link(
    id: ThreadId,
    cwd: string,
    input: ForgePrRef,
    allowed: () => boolean = () => true,
    signal = this.lifetime.signal,
  ): Promise<ForgePrStatus> {
    const pr = ForgePrRef.parse(input);
    signal.throwIfAborted();
    if (!allowed()) throw new Error("forbidden");
    const existing = this.links.getLinkState(id, pr);
    if (existing) {
      try {
        const status = await this.backend(cwd, pr.repository).status(pr.number, signal);
        signal.throwIfAborted();
        if (!allowed()) throw new Error("forbidden");
        this.projection.update(id, status, existing.generation);
        return status;
      } catch (error) {
        signal.throwIfAborted();
        if (!allowed()) throw new Error("forbidden", { cause: error });
        if (error instanceof ForgeError && error.kind === "not_found")
          this.projection.deleted(id, pr, existing.generation);
        else if (
          error instanceof ForgeError &&
          !["cli", "forbidden", "rate_limit"].includes(error.kind)
        )
          throw error;
        return this.projection.fallback(
          pr,
          this.links
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
      status = await this.backend(cwd, pr.repository).status(pr.number, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ForgeError && !["cli", "forbidden", "rate_limit"].includes(error.kind))
        throw error;
      status = this.projection.fallback(pr);
    }
    signal.throwIfAborted();
    if (!allowed()) throw new Error("forbidden");
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    this.store.atomic(() => {
      // Another caller may have linked it while validation was in flight.
      if (this.links.getLinkState(id, pr)) return;
      this.links.link({ threadId: id, pr });
      const generation = this.links.getLinkState(id, pr)?.generation;
      if (status.state === "unknown" && generation !== undefined)
        this.links.update(
          id,
          {
            number: pr.number,
            repo: pr.repository,
            url: prUrl(pr),
            state: "open",
            updatedAt: this.now(),
            unverified: true,
          },
          generation,
        );
      else this.projection.update(id, status, generation);
      this.projection.publish(id);
    });
    return status;
  }
  unlink(id: ThreadId, pr?: ForgePrRef): void {
    this.store.atomic(() => {
      this.links.unlink(id, pr);
      this.projection.publish(id);
    });
  }
  async agent(
    id: ThreadId,
    cwd: string,
    operation: PrOwnerOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult> {
    if (operation.op === "thread.list_prs")
      return { ok: true, data: { linkedPrs: this.links.summaries(id) } };
    if (operation.op === "thread.unlink_pr" && operation.all) {
      signal.throwIfAborted();
      this.unlink(id);
      return { ok: true, data: { all: true, linkedPrs: [] } };
    }
    try {
      const origin = operation.url
        ? undefined
        : "repo" in operation && operation.repo
          ? prRepository(operation.repo, {
              forge: "github",
              host: "github.com",
              owner: "unused",
              name: "unused",
            })
          : await this.repository(cwd);
      const pr = operation.url
        ? prFromUrl(operation.url)
        : ForgePrRef.parse({
            number: operation.number,
            repository:
              origin && "repo" in operation && operation.repo
                ? prRepository(operation.repo, origin)
                : origin,
          });
      if (operation.op === "thread.link_pr") {
        if (!this.links.getLinkState(id, pr))
          await this.link(id, cwd, pr, () => !signal.aborted, signal);
      } else {
        signal.throwIfAborted();
        this.unlink(id, pr);
      }
      return { ok: true, data: { number: pr.number, linkedPrs: this.links.summaries(id) } };
    } catch (error) {
      signal.throwIfAborted();
      return {
        ok: false,
        code: error instanceof ForgeError && error.kind === "not_found" ? "not_found" : "invalid",
      };
    }
  }
  async status(id: ThreadId, cwd: string): Promise<ForgePrStatus | null> {
    const state = this.links.getLinkState(id);
    if (!state) return null;
    const { link, generation } = state;
    try {
      const status = await this.backend(cwd, link.pr.repository).status(
        link.pr.number,
        this.lifetime.signal,
      );
      this.projection.update(id, status, generation);
      return status;
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "not_found") {
        this.projection.deleted(id, link.pr, generation);
        return this.projection.fallback(
          link.pr,
          this.links.summaries(id).find((pr) => pr.number === link.pr.number),
        );
      }
      throw error;
    }
  }
  /** Each sweep batches lightweight state reads per repository, at most 100 refs per request. */
  async refresh(threads: readonly { id: ThreadId; cwd: string }[]): Promise<void> {
    const groups = new Map<
      string,
      {
        cwd: string;
        repo: ForgeRepository;
        entries: { id: ThreadId; pr: ForgePrRef; generation: number }[];
      }
    >();
    for (const thread of threads)
      for (const { link, generation } of this.links.getLinks(thread.id)) {
        const key = repositoryKey(link.pr.repository);
        let group = groups.get(key);
        if (!group) {
          group = { cwd: thread.cwd, repo: link.pr.repository, entries: [] };
          groups.set(key, group);
        }
        group.entries.push({ id: thread.id, pr: link.pr, generation });
      }
    let failure: unknown;
    for (const group of groups.values()) {
      try {
        const backend = this.backend(group.cwd, group.repo);
        const numbers = [...new Set(group.entries.map((entry) => entry.pr.number))];
        if (!backend.states) continue;
        for (let offset = 0; offset < numbers.length; offset += 100) {
          const batch = numbers.slice(offset, offset + 100);
          const summaries = await backend.states(batch, this.lifetime.signal);
          for (const entry of group.entries) {
            if (!batch.includes(entry.pr.number)) continue;
            const summary = summaries.get(entry.pr.number);
            if (summary === null) this.projection.deleted(entry.id, entry.pr, entry.generation);
            else if (
              summary &&
              this.links.getLinkState(entry.id, entry.pr)?.generation === entry.generation
            ) {
              this.links.update(entry.id, summary, entry.generation);
              this.projection.publish(entry.id);
            }
          }
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  /** Host-owned unique branches make remote lookup a durable create receipt. */
  async ensurePr(
    id: ThreadId,
    cwd: string,
    input: ForgeCreatePrInput,
    allowed: () => boolean,
  ): Promise<ForgePrStatus> {
    const value = ForgeCreatePrInput.parse(input);
    const backend = this.backend(cwd, await this.repository(cwd));
    if (!allowed()) throw new Error("forbidden");
    if (!backend.findPr) throw new Error("forge_recovery_unavailable");
    const found = await backend.findPr(value.branch, value.base, this.lifetime.signal);
    if (!allowed()) throw new Error("forbidden");
    const pr = found ?? (await backend.createPr(id, value, this.lifetime.signal));
    if (!allowed()) throw new Error("forbidden");
    // Persist the receipt even if the subsequent status read fails.
    this.links.link({ threadId: id, pr });
    this.projection.publish(id);
    const generation = this.links.getLinkState(id, pr)?.generation;
    const status = await backend.status(pr.number, this.lifetime.signal);
    this.projection.update(id, status, generation);
    return status;
  }
  async execute(
    input: unknown,
    cwd: string,
    allowed: () => boolean,
  ): Promise<Omit<CommandResult, "commandId">> {
    const p = ForgeCommand.parse(input);
    const id = ThreadId.parse("threadId" in p ? p.threadId : p.link.threadId);
    if (!allowed()) return { ok: false, error: "forbidden" };
    if (p.type === "forge.pr.unlink") {
      const thread = this.store.getThread(id);
      if (!thread || thread.deletedAt !== undefined)
        return { ok: false, error: "thread_not_found" };
      const repo = p.repo ?? (p.number ? await this.repository(cwd) : undefined);
      if (!allowed()) return { ok: false, error: "forbidden" };
      this.unlink(id, p.number && repo ? { number: p.number, repository: repo } : undefined);
      return { ok: true };
    }
    if (p.type === "forge.pr.create") {
      if (repositoryKey(p.repository) !== repositoryKey(await this.repository(cwd)))
        throw new Error("repository_mismatch");
      const status = await this.ensurePr(id, cwd, p.input, allowed);
      return { ok: true, pr: status.ref, prStatus: status };
    }
    if (p.type === "forge.pr.link") {
      const status = await this.link(id, cwd, p.link.pr, allowed);
      return { ok: true, pr: p.link.pr, prStatus: status };
    }
    const generation = this.links.getLinkState(id, p.link.pr)?.generation;
    const backend = this.backend(cwd, p.link.pr.repository);
    if (p.type === "forge.comment.reply")
      await backend.replyComment(p.link.pr.number, p.commentId, p.body, this.lifetime.signal);
    if (p.type === "forge.review.request")
      await backend.requestReviews(p.link.pr.number, p.reviewers, this.lifetime.signal);
    if (p.type === "forge.pr.merge")
      await backend.merge(p.link.pr.number, p.headSha, p.method, this.lifetime.signal);
    if (p.type === "forge.pr.auto-merge")
      await backend.enableAutoMerge(p.link.pr.number, p.headSha, p.method, this.lifetime.signal);
    const status = await backend.status(p.link.pr.number, this.lifetime.signal);
    this.projection.update(id, status, generation);
    return { ok: true, pr: status.ref, prStatus: status };
  }
  close(): void {
    this.lifetime.abort();
    this.backends.clear();
  }
}
