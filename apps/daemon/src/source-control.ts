import {
  createCommandRunner,
  githubReadiness,
  githubIdentity,
  identityRunner,
  repositoryFromRemote,
  ForgeError,
  SshHostAliases,
  identityVerificationMs,
  type CommandRunner,
} from "@ace/forge";
import { SourceControlPreferences, type SourceControlReadiness } from "@ace/protocol";
import type { SettingsService } from "@ace/settings";
import type { WorkspaceGit } from "./workspace-roots.ts";

/** Machine-local nonsecret preferences. Every scan reads fresh CLI facts. */
export class SourceControl {
  private settings: SettingsService;
  private currentRevision = 0;
  private closed = false;
  private stop: () => void;
  private listeners = new Set<() => void>();
  /** Verified API accounts per host and preferences revision, reused for a short window. */
  private identities = new Map<string, { account: string; revision: number; at: number }>();
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
    if (!configured) throw new ForgeError("unsupported");
    const runner = this.runner(cwd);
    const { account, at } = await this.verifiedAccount(runner, host, revision, signal);
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
  /** One `/user` probe per host per window, not one per operation. */
  private async verifiedAccount(
    runner: CommandRunner,
    host: string,
    revision: number,
    signal: AbortSignal,
  ) {
    const cached = this.identities.get(host);
    const now = this.now();
    if (
      cached &&
      cached.revision === revision &&
      now - cached.at >= 0 &&
      now - cached.at < identityVerificationMs
    )
      return cached;
    const verified = {
      account: await githubIdentity(runner, host, signal, this.now),
      revision,
      at: now,
    };
    if (revision === this.currentRevision) this.identities.set(host, verified);
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
    const status = await githubReadiness(runner, preferences, signal, this.now);
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
        Object.fromEntries(preferences.hosts.map((entry) => [entry.host, "github"])),
        await this.hostAliases([remote], signal),
      );
      const result = await runner({
        command: "git",
        args: ["-c", "credential.interactive=false", "ls-remote", "--", remote, "HEAD"],
        mode: "json",
        signal,
      });
      status.transport = result.code === 0 ? "ready" : "failed";
      status.transportInstructions =
        result.code === 0
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
