import type { DiscoveryOptions, DiscoveryResult } from "@ace/provider-kit/discovery";
import type { ElisionLimits } from "@ace/provider-kit/elision";
import { codexCapabilities } from "./capabilities.ts";
import { CodexHost, type ChannelHandlers, type CodexChannel } from "./host.ts";
import type { CodexRuntime } from "./runtime.ts";
import type { CodexSessionContext } from "./session-context.ts";
import type { InitializeParams } from "./generated/InitializeParams.ts";

/** A shared app-server with no sessions stays up this long for the next one. */
export const defaultHostIdleMs = 10 * 60_000;

/**
 * Codex keeps every generated image inline as base64 (`imageGeneration.result`, megabytes each)
 * and returns them with history on `thread/resume` and `thread/read`. ace reads only the item's
 * `savedPath`, so base64 past 16 KiB becomes a placeholder before the line limit counts it.
 *
 * Readable text is never cut short of the 16 MiB line limit. Command output, diffs and messages
 * are payload ace shows, and a frame past the provider payload bound already has an explicit
 * outcome: an optional catalog frame is omitted with a note, an execution frame fails its
 * thread visibly. Truncating text would replace those with silently altered content.
 */
const codexElision: ElisionLimits = { holdBytes: 16 * 1024, textBytes: 16 * 1024 * 1024 };

const initialize = {
  clientInfo: { name: "ace", title: "ace", version: "0.0.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
} satisfies InitializeParams;

/**
 * Live app-servers by everything fixed at spawn: executable, environment (account home) and
 * process-level arguments. Thread-level settings travel in each `thread/start`.
 */
export class CodexHostPool {
  readonly idleMs: number;
  readonly #hosts = new Map<string, CodexHost>();
  readonly #starting = new Map<string, Promise<CodexHost>>();
  constructor(options: { idleMs?: number } = {}) {
    this.idleMs = options.idleMs ?? defaultHostIdleMs;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 0)
      throw new Error("Invalid Codex host idle time");
  }
  /** Stop every app-server, whatever sessions remain on it. */
  async close(): Promise<void> {
    await Promise.all([...this.#hosts.values()].map((host) => host.retire()));
  }
  async host(key: string, start: (retired: () => void) => Promise<CodexHost>): Promise<CodexHost> {
    const live = this.#hosts.get(key);
    if (live?.available) return live;
    const pending = this.#starting.get(key);
    if (pending) return pending;
    let created: CodexHost | undefined;
    const retired = () => {
      if (created && this.#hosts.get(key) === created) this.#hosts.delete(key);
    };
    const starting = start(retired).then((host) => {
      created = host;
      if (host.available) this.#hosts.set(key, host);
      return host;
    });
    this.#starting.set(key, starting);
    try {
      return await starting;
    } finally {
      this.#starting.delete(key);
    }
  }
}

export type ChannelOptions = {
  ctx: CodexSessionContext;
  io: CodexRuntime;
  discovery?: DiscoveryOptions;
  cli?: DiscoveryResult;
  /** The caller replaced whole-catalog discovery; use it instead of the single probe. */
  discoverAll?: boolean;
  /** Absent: a private process for this session alone. */
  pool?: CodexHostPool;
  handlers: ChannelHandlers;
};

function spawnKey(ctx: CodexSessionContext, env: NodeJS.ProcessEnv | undefined): string {
  const entries = Object.entries(env ?? {})
    .filter(([name, value]) => value !== undefined && name !== "ACE_MCP_BEARER_TOKEN")
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([ctx.executable ?? null, ctx.builtinSkills?.args ?? [], entries]);
}

async function discover(options: ChannelOptions): Promise<string> {
  const { ctx, io } = options;
  const discovery = {
    ...options.discovery,
    ...(ctx.env ? { env: ctx.env } : {}),
    signal: ctx.signal,
  };
  const cli = ctx.executable
    ? await io.discoverProvider("codex", {
        ...discovery,
        overrides: { ...discovery.overrides, codex: ctx.executable },
      })
    : (options.cli ??
      (options.discoverAll
        ? (await io.discover(discovery)).codex
        : await io.discoverProvider("codex", discovery)));
  if (!cli.installed || !cli.path)
    throw new Error("Codex is not installed. Install it or configure its path.");
  if (!codexCapabilities(cli).steer)
    throw new Error(
      `Codex ${cli.version ?? "unknown version"} is unsupported; need 0.159.1 or newer.`,
    );
  return cli.path;
}

function startHost(
  options: ChannelOptions,
  dedicated: boolean,
  idleMs: number,
  retired: () => void,
): Promise<CodexHost> {
  const { ctx, io } = options;
  const env = ctx.env ?? options.discovery?.env;
  return discover(options).then(
    (command) =>
      new CodexHost({
        dedicated,
        initialize,
        graceMs: io.stopGraceMs,
        idleMs,
        schedule: io.schedule,
        onRetired: retired,
        spawn: (flow, dropped) =>
          io.spawn({
            command,
            args: [...(ctx.builtinSkills?.args ?? []), "app-server"],
            // A shared process outlives any one workspace; threads carry their own cwd.
            cwd: dedicated ? ctx.cwd : io.homeDir(),
            outputFlow: flow,
            ...(!dedicated ? { onStdoutLineDropped: dropped } : {}),
            elideStdout: codexElision,
            env: { ...env, ACE_MCP_BEARER_TOKEN: undefined },
            name: "ace-codex",
            ...(ctx.builtinSkills?.lease ? { lease: ctx.builtinSkills.lease } : {}),
          }),
      }),
  );
}

/** Attach a session to a running app-server, starting one when none fits. */
export async function openChannel(options: ChannelOptions): Promise<CodexChannel> {
  const { ctx, pool } = options;
  if (!pool) {
    const host = await startHost(options, true, 0, () => {});
    return host.attach(options.handlers, ctx.signal);
  }
  const key = spawnKey(ctx, ctx.env ?? options.discovery?.env);
  const host = await pool.host(key, (retired) => startHost(options, false, pool.idleMs, retired));
  return host.attach(options.handlers, ctx.signal);
}
