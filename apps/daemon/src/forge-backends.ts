import {
  GitHubForge,
  GitHubInbox,
  ForgeError,
  ForgeListCaches,
  repositoryKey,
  type CommandRunner,
} from "@ace/forge";
import type { ForgeRepository } from "@ace/protocol";
import type { ForgeReplyReceipts } from "./forge-reply-receipts.ts";
import type { SourceControl } from "./source-control.ts";
import type { WorkspaceForgeGit } from "./workspace-forge-context.ts";
import { workspaceRepository } from "./workspace-repository.ts";
import { remotePushesTo } from "./workspace-push.ts";

/** Resolves a checkout's forge repository and keeps one GitHub backend per identity. */
export class ForgeBackends {
  private backends = new Map<string, GitHubForge>();
  /** Open PR and issue lists per repository and identity, whichever checkout reads them. */
  private lists = new Map<string, ForgeListCaches>();
  /** Each host's notifications per signed-in account, kept so conditional reads find their page. */
  private inboxes = new Map<string, GitHubInbox>();
  private git: WorkspaceForgeGit;
  private now: () => number;
  private runner: (cwd: string) => CommandRunner;
  private sourceControl: SourceControl | undefined;
  private replyReceipts: ForgeReplyReceipts;
  private signal: AbortSignal;
  constructor(options: {
    git: WorkspaceForgeGit;
    now: () => number;
    runner: (cwd: string) => CommandRunner;
    sourceControl: SourceControl | undefined;
    replyReceipts: ForgeReplyReceipts;
    signal: AbortSignal;
  }) {
    this.git = options.git;
    this.now = options.now;
    this.runner = options.runner;
    this.sourceControl = options.sourceControl;
    this.replyReceipts = options.replyReceipts;
    this.signal = options.signal;
  }
  clear(): void {
    this.backends.clear();
    this.lists.clear();
    this.inboxes.clear();
  }
  async repository(cwd: string): Promise<ForgeRepository> {
    return (await this.checkoutRepository(cwd)).repository;
  }
  /** The selected remote's repository, with SSH host aliases resolved, and the remote names. */
  async checkoutRepository(cwd: string) {
    const info = await this.git.repositoryInfo(cwd);
    const preferences = await this.sourceControl?.preferences();
    const aliases = await this.hostAliases(info.remotes);
    const repository = workspaceRepository(info.remotes, preferences, aliases);
    if (!repository) throw new ForgeError("unsupported");
    return { repository, remotes: info.remotes.map((remote) => remote.name) };
  }
  async hostAliases(remotes: readonly { fetchUrls: readonly string[] }[]) {
    return (
      (await this.sourceControl?.hostAliases(
        remotes.flatMap((remote) => remote.fetchUrls),
        this.signal,
      )) ?? {}
    );
  }
  async backend(cwd: string, repository: ForgeRepository): Promise<GitHubForge> {
    const identity = await this.sourceControl?.identity(cwd, repository.host, this.signal);
    const listKey = JSON.stringify({
      repository: repositoryKey(repository),
      account: identity?.account,
      revision: identity?.revision,
    });
    const key = JSON.stringify({ listKey, cwd });
    let backend = this.backends.get(key);
    const pushLeased = this.git.pushLeased?.bind(this.git);
    if (!backend)
      backend = new GitHubForge({
        repository,
        runner: identity?.runner ?? this.runner(cwd),
        ...(pushLeased
          ? {
              publishStack: async (request) => {
                const info = await this.git.repositoryInfo(cwd);
                const remote = info.remotes.find((entry) => entry.name === request.remote);
                const preferences = await this.sourceControl?.preferences();
                const aliases = await this.hostAliases(
                  remote ? [{ fetchUrls: remote.pushUrls }] : [],
                );
                if (!remotePushesTo(remote, repository, preferences, aliases))
                  throw new ForgeError("conflict");
                return pushLeased({ ...request, worktree: cwd });
              },
            }
          : {}),
        now: this.now,
        lists: this.listCaches(listKey),
        replyReceipts: this.replyReceipts.scope(cwd, repository, identity?.account ?? ""),
      });
    this.backends.delete(key);
    this.backends.set(key, backend);
    if (this.backends.size > 32) {
      const first = this.backends.keys().next().value;
      if (first !== undefined) this.backends.delete(first);
    }
    return backend;
  }
  /**
   * The signed-in account's notifications on `host`, or on the host of the checkout's own
   * repository. Every request goes through the identity-checked runner.
   */
  async inbox(cwd: string, host: string | undefined): Promise<GitHubInbox> {
    const target = host ?? (await this.repository(cwd)).host;
    const identity = await this.sourceControl?.identity(cwd, target, this.signal);
    const key = JSON.stringify({
      host: target,
      account: identity?.account,
      revision: identity?.revision,
    });
    const inbox =
      this.inboxes.get(key) ??
      new GitHubInbox({
        host: target,
        runner: identity?.runner ?? this.runner(cwd),
        now: this.now,
      });
    this.inboxes.delete(key);
    this.inboxes.set(key, inbox);
    if (this.inboxes.size > 8) {
      const first = this.inboxes.keys().next().value;
      if (first !== undefined) this.inboxes.delete(first);
    }
    return inbox;
  }
  private listCaches(key: string): ForgeListCaches {
    const lists = this.lists.get(key) ?? new ForgeListCaches(this.now);
    this.lists.delete(key);
    this.lists.set(key, lists);
    if (this.lists.size > 32) {
      const first = this.lists.keys().next().value;
      if (first !== undefined) this.lists.delete(first);
    }
    return lists;
  }
}
