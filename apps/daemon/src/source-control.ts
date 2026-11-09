import {
  createCommandRunner,
  githubReadiness,
  gitlabReadiness,
  gitlabIdentity,
  originReadiness,
  originIdentity,
  githubIdentity,
  identityRunner,
  repositoryFromRemote,
  ForgeError,
  SshHostAliases,
  identityVerificationMs,
  isReadOnlyApiRequest,
  pinnedRunner,
  type CommandRunner,
} from "@ace/forge";
import {
  SourceControlPreferences,
  configuredForge,
  configuredForges,
  type ForgeKind,
  type SourceControlReadiness,
  type ForgeRepository,
} from "@ace/protocol";
import type { SettingsService } from "@ace/settings";
import { GitError } from "@ace/git";
import type { WorkspaceGit } from "./workspace-roots.ts";

/** How long a verified account may name backends while it is probed again behind them. */
const identityReuseMs = 30 * 60_000;

/** Machine-local nonsecret preferences. Every scan reads fresh CLI facts. */
export class SourceControl {
  private settings: SettingsService;
  private currentRevision = 0;
  private closed = false;
  private stop: () => void;
  private listeners = new Set<() => void>();
  /** Verified API accounts per provider and host and preferences revision, reused for a short
   * window. Cleared by every preferences change and rescan, the account-change signals. */
  private identities = new Map<string, { account: string; revision: number; at: number }>();
  /** Hosts whose account is being probed again behind a reused answer. */
  private reverifying = new Set<string>();
  private aliases: SshHostAliases;
  get revision(): number {
    return this.currentRevision;
  }
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async guard(): Promise<() => void> {
    await this.preferences();
    const revision = this.currentRevision;
    return () => {
      if (this.closed || this.currentRevision !== revision)
        throw new ForgeError("preferences_changed");
    };
  }
  close(): void {
    this.closed = true;
    this.stop();
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  readonly root: string;
  readonly now: () => number;
  readonly runner: (cwd: string) => CommandRunner;
  constructor(
    settings: SettingsService,
    runner = (cwd: string) => createCommandRunner({ cwd }),
    root = ".",
    now: () => number = Date.now,
  ) {
    this.settings = settings;
    this.now = now;
    this.root = root;
    this.runner = runner;
    this.aliases = new SshHostAliases({ runner: runner(root), now });
    this.stop = settings.onChange((layer, keys) => {
      if (layer.kind !== "global" || !keys.includes("sourceControl.preferences")) return;
      this.currentRevision++;
      this.identities.clear();
      for (const listener of this.listeners) listener();
    });
  }
  async preferences(): Promise<SourceControlPreferences> {
    return SourceControlPreferences.parse(
      (await this.settings.get("sourceControl.preferences")).value,
    );
  }
  async identity(cwd: string, host: string, signal: AbortSignal) {
    const revision = this.currentRevision;
    const preferences = await this.preferences();
    const check = () => {
      if (this.closed || this.currentRevision !== revision)
        throw new ForgeError("preferences_changed");
    };
    const assertCurrent = async () => {
      await this.preferences();
      check();
    };
    check();
    const configured = preferences.hosts.find((entry) => entry.host === host);
    if (!configured || configuredForge(configured) !== "github")
      throw new ForgeError("unsupported");
    const runner = this.runner(cwd);
    const { account, at } = await this.verifiedAccount(
      `github ${host}`,
      (probe) => githubIdentity(runner, host, probe, this.now),
      revision,
      signal,
    );
    await assertCurrent();
    if (configured.account && configured.account !== account) throw new ForgeError("forbidden");
    return {
      account,
      revision,
      check,
      runner: identityRunner(runner, host, account, assertCurrent, {
        now: this.now,
        verifiedAt: at,
      }),
    };
  }
  /**
   * Alternative host reads are pinned to an admitted CLI identity and preferences revision, and
   * admit only explicit GET API requests. The account is re-probed at most once per verification
   * window per host (always after a preferences change or rescan), beside the read it gates.
   */
  async readIdentity(cwd: string, repository: ForgeRepository, signal: AbortSignal) {
    if (repository.forge === "github") return this.identity(cwd, repository.host, signal);
    const forge = repository.forge;
    if (forge !== "gitlab" && forge !== "origin") throw new ForgeError("unsupported");
    const revision = this.currentRevision;
    const check = await this.guard();
    const preferences = await this.preferences();
    const configured = preferences.hosts.find((entry) => entry.host === repository.host);
    if (!configured || configuredForge(configured) !== forge) throw new ForgeError("unsupported");
    const runner = this.runner(cwd);
    const identify = (probe: AbortSignal) =>
      forge === "origin"
        ? originIdentity(runner, probe)
        : gitlabIdentity(runner, repository.host, probe);
    const key = `${forge} ${repository.host}`;
    const { account, at } = await this.verifiedAccount(key, identify, revision, signal);
    check();
    if (configured.account && configured.account !== account) throw new ForgeError("forbidden");
    const cli = forge === "origin" ? "origin" : "glab";
    const pinned = pinnedRunner({
      runner,
      account,
      identify,
      pins: () => true,
      isWrite: () => false,
      assertCurrent: check,
      options: {
        now: this.now,
        verifiedAt: at,
        onVerified: (verifiedAt) => {
          if (revision === this.currentRevision)
            this.identities.set(key, { account, revision, at: verifiedAt });
        },
        onMismatch: () => this.identities.delete(key),
      },
    });
    const verified: CommandRunner = async (request) => {
      check();
      request.signal.throwIfAborted();
      if (!isReadOnlyApiRequest(cli, request)) throw new ForgeError("unsupported");
      const result = await pinned(request);
      check();
      return result;
    };
    return { account, revision, check, runner: verified };
  }
  /** One identity probe per provider host per window, not one per operation. */
  private async verifiedAccount(
    key: string,
    identify: (signal: AbortSignal) => Promise<string>,
    revision: number,
    signal: AbortSignal,
  ) {
    const cached = this.identities.get(key);
    const now = this.now();
    const age = cached && cached.revision === revision ? now - cached.at : -1;
    if (cached && age >= 0 && age < identityVerificationMs) return cached;
    // A recent answer still names the backend, and the runner proves the account of every
    // request it sends, so the next read need not wait for this probe; it runs behind it.
    if (cached && age >= 0 && age < identityReuseMs) {
      if (!this.reverifying.has(key)) {
        this.reverifying.add(key);
        void this.probeAccount(key, identify, revision, signal)
          .catch(() => undefined)
          .finally(() => this.reverifying.delete(key));
      }
      return cached;
    }
    return this.probeAccount(key, identify, revision, signal);
  }
  private async probeAccount(
    key: string,
    identify: (signal: AbortSignal) => Promise<string>,
    revision: number,
    signal: AbortSignal,
  ) {
    const now = this.now();
    const verified = { account: await identify(signal), revision, at: now };
    if (revision === this.currentRevision) this.identities.set(key, verified);
    return verified;
  }
  /** Real hosts behind SSH host aliases in these remote URLs (`~/.ssh/config` `Host` entries). */
  hostAliases(urls: readonly string[], signal: AbortSignal): Promise<Record<string, string>> {
    return this.aliases.resolve(urls, signal);
  }
  async readiness(
    cwd: string,
    signal: AbortSignal,
    git?: WorkspaceGit,
  ): Promise<SourceControlReadiness> {
    const check = await this.guard();
    const preferences = await this.preferences();
    const runner = this.runner(cwd);
    const selected = preferences.hosts.find((entry) => entry.host === preferences.host);
    const forge: ForgeKind = selected ? configuredForge(selected) : "github";
    const status: SourceControlReadiness =
      forge === "github"
        ? await githubReadiness(runner, preferences, signal, this.now)
        : forge === "gitlab"
          ? await gitlabReadiness(runner, preferences, signal)
          : forge === "origin"
            ? await originReadiness(runner, preferences, signal)
            : {
                preferences,
                cli: "unavailable",
                version: null,
                accounts: [],
                account: null,
                api: "unavailable",
                instructions:
                  "Host saved. Pull requests, issues and API connection checks for this provider are not available yet. Git clone and push use your existing Git credentials.",
                transport: "unchecked",
                transportInstructions: "Check a project's remote to verify Git access.",
              };
    // A rescan re-verifies identity from scratch.
    this.identities.clear();
    check();
    if (!git) return status;
    const info = await git.repositoryInfo(cwd);
    const remote = info.remotes.find((entry) => entry.name === preferences.remote)?.fetchUrls[0];
    status.transport = "no_remote";
    status.transportInstructions = `This project has no ${preferences.remote} remote.`;
    check();
    if (!remote) return status;
    try {
      // Reject arbitrary or credential-bearing URLs before probing transport.
      if (remote.includes("://")) {
        const url = new URL(remote);
        if (url.password || (url.protocol === "https:" && url.username))
          throw new Error("invalid_remote");
      }
      repositoryFromRemote(
        remote,
        configuredForges(preferences.hosts),
        await this.hostAliases([remote], signal),
      );
      // The same transport a push uses (credential helpers, SSH command, no prompts), so a
      // ready remote is one a push can reach.
      const readable = await git
        .probeRemote({ worktree: cwd, remote: preferences.remote, signal })
        .then(
          () => true,
          (error: unknown) => {
            if (error instanceof GitError) return false;
            throw error;
          },
        );
      status.transport = readable ? "ready" : "failed";
      status.transportInstructions = readable
        ? "Git can read this remote. Push permission is verified only when you push."
        : "Git cannot read this remote. Check its URL, repository permission and your Git credential helper / SSH key on this computer. API sign-in alone does not grant Git access.";
    } catch {
      signal.throwIfAborted();
      status.transport = "failed";
      status.transportInstructions =
        "Git transport check failed. Check the configured host, remote URL, network and Git credentials on this computer.";
    }
    check();
    return status;
  }
}
