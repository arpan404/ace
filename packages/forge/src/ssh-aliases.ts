import type { CommandRunner } from "./command.ts";

const literalHosts = new Set(["github.com", "gitlab.com", "ssh.github.com"]);
const alias = /^[A-Za-z0-9_][\w.-]{0,252}$/;

/** The host of an SSH remote (`user@host:path` or `ssh://user@host/path`), if it is one. */
export function sshRemoteHost(remote: string): string | undefined {
  if (!remote.includes("://")) {
    const scp = /^(?:[\w.-]+@)?([\w.-]+):[^/]/.exec(remote);
    return scp?.[1]?.toLowerCase();
  }
  try {
    const url = new URL(remote);
    return url.protocol === "ssh:" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** The effective `hostname` from `ssh -G` output, which applies `~/.ssh/config` without connecting. */
export function sshConfigHostname(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = /^hostname\s+([\w.-]{1,253})\s*$/i.exec(line.trim());
    if (match?.[1]) return match[1].toLowerCase();
  }
  return undefined;
}

/**
 * Resolves SSH host aliases (multi-account `Host github-work` entries) to the host they name.
 * `ssh -G` reads configuration only; it never opens a connection. Results are cached briefly
 * so remote detection on hot paths spawns no process.
 */
export class SshHostAliases {
  readonly #runner: CommandRunner;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #command: string;
  readonly #cache = new Map<string, { host: string | undefined; at: number }>();
  constructor(options: {
    runner: CommandRunner;
    now: () => number;
    ttlMs?: number;
    command?: string;
  }) {
    this.#runner = options.runner;
    this.#now = options.now;
    this.#ttlMs = options.ttlMs ?? 300_000;
    this.#command = options.command ?? "ssh";
  }
  /** Alias to real host, for each SSH remote host whose configuration names another host. */
  async resolve(remotes: readonly string[], signal: AbortSignal): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const hosts = new Set(
      remotes.flatMap((remote) => {
        const host = sshRemoteHost(remote);
        return host && !literalHosts.has(host) && alias.test(host) ? [host] : [];
      }),
    );
    for (const host of hosts) {
      const resolved = await this.#lookup(host, signal);
      if (resolved && resolved !== host) result[host] = resolved;
    }
    return result;
  }
  async #lookup(host: string, signal: AbortSignal): Promise<string | undefined> {
    const cached = this.#cache.get(host);
    const now = this.#now();
    if (cached && now - cached.at >= 0 && now - cached.at < this.#ttlMs) return cached.host;
    let resolved: string | undefined;
    try {
      const output = await this.#runner({
        command: this.#command,
        args: ["-G", host],
        signal,
        mode: "json",
      });
      resolved = output.code === 0 ? sshConfigHostname(output.stdout) : undefined;
    } catch {
      signal.throwIfAborted();
      // No ssh client: remotes are matched by their literal host.
    }
    this.#cache.set(host, { host: resolved, at: now });
    while (this.#cache.size > 256) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return resolved;
  }
}
