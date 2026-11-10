import {
  GitHubForge,
  GitLabReader,
  GitLabCreation,
  OriginReader,
  type ForgeReader,
  GitHubInbox,
  ForgeError,
  ForgeListCaches,
  OriginListSnapshots,
  repositoryKey,
  repositoryWriteRefusal,
  resolveProjectRepositories,
  type CommandRunner,
  type HostApiWrite,
} from "@ace/forge";
import {
  configuredForge,
  readableForges,
  type ForgeRepository,
  type LinkedPullRequest,
} from "@ace/protocol";
import type { ForgeReplyReceipts } from "./forge-reply-receipts.ts";
import type { SourceControl } from "./source-control.ts";
import type { WorkspaceForgeGit } from "./workspace-forge-context.ts";
import type { ProjectRepositoryConfigs } from "./project-repository-config.ts";
import { remotePushesTo } from "./workspace-push.ts";
import { prHeadMetadata, resolvePrHead } from "./pr-head.ts";

/** How many GitLab or Origin pull requests one state refresh reads at once. */
const stateReadConcurrency = 4;

/** Resolves a checkout's forge repository and keeps one GitHub backend per identity. */
export class ForgeBackends {
  private backends = new Map<string, GitHubForge>();
  /** Open PR and issue lists per repository and identity, whichever checkout reads them. */
  private lists = new Map<string, ForgeListCaches>();
  /** Each host's notifications per signed-in account, kept so conditional reads find their page. */
  private inboxes = new Map<string, GitHubInbox>();
  /** Origin list traversals per admitted account, so page turns don't read every page again. */
  private originSnapshots = new Map<string, OriginListSnapshots>();
  private git: WorkspaceForgeGit;
  private now: () => number;
  private runner: (cwd: string) => CommandRunner;
  private sourceControl: SourceControl | undefined;
  private replyReceipts: ForgeReplyReceipts;
  private signal: AbortSignal;
  private configs: Pick<ProjectRepositoryConfigs, "forCheckout">;
  constructor(options: {
    git: WorkspaceForgeGit;
    now: () => number;
    runner: (cwd: string) => CommandRunner;
    sourceControl: SourceControl | undefined;
    replyReceipts: ForgeReplyReceipts;
    signal: AbortSignal;
    /** Each checkout's project repository choices; none keeps today's single repository. */
    configs?: Pick<ProjectRepositoryConfigs, "forCheckout">;
  }) {
    this.configs = options.configs ?? { forCheckout: () => undefined };
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
    this.originSnapshots.clear();
  }
  async repository(cwd: string): Promise<ForgeRepository> {
    return (await this.checkoutRepository(cwd)).repository;
  }
  /** The project's primary repository, with SSH host aliases resolved, and the remote names. */
  async checkoutRepository(cwd: string) {
    const { resolved, remotes } = await this.projectRepositories(cwd);
    const repository = resolved.primary?.repository;
    if (!repository) throw new ForgeError("unsupported");
    return { repository, remotes };
  }
  /** Every repository of the checkout's project (ADR 0116), read from Git and saved choices. */
  async projectRepositories(cwd: string) {
    const info = await this.git.repositoryInfo(cwd);
    const preferences = await this.sourceControl?.preferences();
    const aliases = await this.hostAliases(info.remotes);
    const config = this.configs.forCheckout(cwd);
    return {
      resolved: resolveProjectRepositories({ remotes: info.remotes, preferences, aliases, config }),
      config,
      globalRemote: preferences?.remote ?? "origin",
      remotes: info.remotes.map((remote) => remote.name),
    };
  }
  /**
   * Where a new pull request's branch is pushed (`resolvePrHead`), with the project's
   * repositories. `metadata` reads what PR creation needs to find where the PR opens.
   */
  async prHead(cwd: string) {
    const project = await this.projectRepositories(cwd);
    const read = async (entry: { repository: ForgeRepository }) => {
      if (entry.repository.forge === "gitlab")
        return new GitLabCreation({
          repository: entry.repository,
          runner: await this.hostRunner(cwd, entry.repository, [], this.signal),
        }).repositoryMetadata(this.signal);
      return (await this.backend(cwd, entry.repository)).repositoryMetadata(this.signal);
    };
    const head = await resolvePrHead({
      resolved: project.resolved,
      globalRemote: project.globalRemote,
      metadata: read,
    });
    return {
      head,
      project,
      /** The pushed repository's metadata, its parent cleared when the project refuses it. */
      metadata: () => prHeadMetadata(head, project.resolved, read),
    };
  }
  /** The GitHub backend for a write, refused when the project hides or can't use `repository`. */
  async writer(cwd: string, repository: ForgeRepository): Promise<GitHubForge> {
    await this.assertWritable(cwd, repository);
    return this.backend(cwd, repository);
  }
  private async assertWritable(cwd: string, repository: ForgeRepository): Promise<void> {
    const refusal = repositoryWriteRefusal(
      (await this.projectRepositories(cwd)).resolved,
      repository,
    );
    if (refusal) throw new Error(refusal);
  }
  /** Non-GitHub writers use exact adapter admissions after project visibility refusal. */
  async admittedWriter(
    cwd: string,
    repository: ForgeRepository,
    writes: readonly HostApiWrite[],
    signal: AbortSignal,
  ) {
    await this.assertWritable(cwd, repository);
    if (!this.sourceControl) throw new ForgeError("unsupported");
    return this.sourceControl.writeIdentity(cwd, repository, writes, signal);
  }
  /** Alternate-host I/O shares the repository refusal and identity fence of GitHub writes. */
  async hostRunner(
    cwd: string,
    repository: ForgeRepository,
    writes: readonly HostApiWrite[],
    signal: AbortSignal,
  ): Promise<CommandRunner> {
    if (!this.sourceControl) throw new ForgeError("unsupported");
    if (writes.length > 0) {
      const refusal = repositoryWriteRefusal(
        (await this.projectRepositories(cwd)).resolved,
        repository,
      );
      if (refusal) throw new Error(refusal);
      return (await this.sourceControl.writeIdentity(cwd, repository, writes, signal)).runner;
    }
    return (await this.sourceControl.readIdentity(cwd, repository, signal)).runner;
  }
  async hostAliases(remotes: readonly { fetchUrls: readonly string[] }[]) {
    return (
      (await this.sourceControl?.hostAliases(
        remotes.flatMap((remote) => remote.fetchUrls),
        this.signal,
      )) ?? {}
    );
  }
  /** Host-specific reads never share GitHub's API transport or mutation backend. They only
   * run through SourceControl's identity-pinned, GET-only runner, never an unchecked one. */
  async reader(
    cwd: string,
    repository: ForgeRepository,
    signal: AbortSignal,
  ): Promise<ForgeReader> {
    if (repository.forge === "github") return this.backend(cwd, repository);
    if (!readableForges.includes(repository.forge) || !this.sourceControl)
      throw new ForgeError("unsupported");
    const identity = await this.sourceControl.readIdentity(cwd, repository, signal);
    const options = { repository, runner: identity.runner };
    if (repository.forge === "gitlab") return new GitLabReader(options);
    return new OriginReader({
      ...options,
      snapshots: this.snapshots(
        JSON.stringify({ account: identity.account, revision: identity.revision }),
      ),
    });
  }
  /**
   * Each pull request's state, keyed by number: null when it no longer exists, and absent when
   * this read can't say (a state GitLab or Origin added later, which must never read as open),
   * so the caller keeps that link's previous summary.
   */
  async states(
    cwd: string,
    repository: ForgeRepository,
    numbers: readonly number[],
    signal: AbortSignal,
  ): Promise<Map<number, LinkedPullRequest | null>> {
    if (repository.forge === "github")
      return (await this.backend(cwd, repository)).states(numbers, signal);
    const reader = await this.reader(cwd, repository, signal);
    const result = new Map<number, LinkedPullRequest | null>();
    const read = async (number: number) => {
      try {
        const status = await reader.status(number, signal);
        if (status.state === "unknown") return;
        result.set(number, {
          number,
          repo: repository,
          state: status.state,
          url: status.url,
          title: status.title,
          head: status.headSha,
          updatedAt: this.now(),
        });
      } catch (error) {
        if (error instanceof ForgeError && error.kind === "not_found") result.set(number, null);
        else throw error;
      }
    };
    let next = 0;
    const worker = async () => {
      while (next < numbers.length) {
        const number = numbers[next++];
        if (number !== undefined) await read(number);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(stateReadConcurrency, numbers.length) }, worker),
    );
    return result;
  }
  async backend(cwd: string, repository: ForgeRepository): Promise<GitHubForge> {
    if (repository.forge !== "github") throw new ForgeError("unsupported");
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
  /** Resolve an inbox host through the project's repositories and configured provider. */
  async inboxRepository(cwd: string, host: string | undefined): Promise<ForgeRepository> {
    const own = await this.repository(cwd).catch((error: unknown) => {
      if (host) return undefined;
      throw error;
    });
    if (own && (!host || own.host === host)) return own;
    if (!host) throw new ForgeError("unsupported");
    const entries = (await this.projectRepositories(cwd)).resolved.repositories;
    const entry = entries.find(
      (item) => item.visible && item.available && item.repository.host === host,
    );
    if (entry) return entry.repository;
    const configured = (await this.sourceControl?.preferences())?.hosts.find(
      (item) => item.host === host,
    );
    if (!configured) throw new ForgeError("unsupported");
    // Inbox is account-wide; no real repository is needed to read its host's to-dos.
    return { forge: configuredForge(configured), host, owner: "inbox", name: "inbox" };
  }
  async inbox(cwd: string, host: string | undefined): Promise<GitHubInbox> {
    const repository = host ? undefined : await this.repository(cwd);
    if (repository && repository.forge !== "github") throw new ForgeError("unsupported");
    const target = host || repository?.host;
    if (!target) throw new ForgeError("unsupported");
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
  private snapshots(key: string): OriginListSnapshots {
    const snapshots = this.originSnapshots.get(key) ?? new OriginListSnapshots(this.now);
    this.originSnapshots.delete(key);
    this.originSnapshots.set(key, snapshots);
    if (this.originSnapshots.size > 8) {
      const first = this.originSnapshots.keys().next().value;
      if (first !== undefined) this.originSnapshots.delete(first);
    }
    return snapshots;
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
