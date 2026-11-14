import { mcpReadyPluginDirectory } from "./mcp-ready.ts";
import { z } from "zod";
import type { SessionContext } from "@ace/engine-api";
import { OpenCodeServer, type ServerOptions } from "./server.ts";
import { runtime } from "./runtime.ts";
import { AceMcpConnectionSchema } from "@ace/mcp-server";
const Environment = z
  .record(z.string().max(256), z.string().max(32768).optional())
  .refine((env) => Object.keys(env).length <= 512);
type Entry = {
  accountKey: string;
  server: OpenCodeServer;
  env: NodeJS.ProcessEnv | undefined;
  users: number;
  scoped: boolean;
  closing?: Promise<void>;
};
/** A started server no session has used yet, waiting for the next one with its configuration. */
type Spare = { server: OpenCodeServer; env: NodeJS.ProcessEnv | undefined; expire(): void };
/** A spare outlives the last activity of its configuration by this long, then stops. */
export const spareIdleMs = 10 * 60_000;
const spareLimit = 8;
/** Account identity owns transport lifetime; a session's abort owns only that session. */
export class ServerPool {
  private entries = new Map<string, Entry>();
  private spares = new Map<string, Spare>();
  private anonymous = new WeakMap<NodeJS.ProcessEnv, string>();
  private serial = 0;
  private closed = false;
  constructor(privateOptions: ServerOptions) {
    this.options = privateOptions;
  }
  private options: ServerOptions;
  assertOpen(): void {
    if (this.closed) throw new Error("OpenCode adapter is closed");
  }
  async acquire(ctx: SessionContext): Promise<{
    server: OpenCodeServer;
    release(): Promise<void>;
    /** The session opened on this server; a scoped one readies a spare for the next. */
    opened(): void;
  }> {
    if (this.closed) throw new Error("OpenCode adapter is closed");
    const connection = ctx.aceMcp
      ? AceMcpConnectionSchema.parse({ url: ctx.aceMcp.url, bearer: ctx.aceMcp.bearer })
      : undefined;
    if (connection && this.options.attach)
      throw new Error(
        "Scoped ace MCP requires an owned OpenCode server; external attachment cannot isolate session credentials",
      );
    const env = ctx.env === undefined ? undefined : Environment.parse(ctx.env);
    let key =
      ctx.instanceId === undefined
        ? "default"
        : `account:${z.string().min(1).max(512).parse(ctx.instanceId)}`;
    if (ctx.instanceId === undefined && ctx.env) {
      key = this.anonymous.get(ctx.env) ?? `anonymous:${++this.serial}`;
      this.anonymous.set(ctx.env, key);
    }
    let launch = ctx.executable ? `:binary:${ctx.executable}` : "";
    // Skills are process-wide config: a process started without them never serves a session
    // that has them.
    const skillDirectories = ctx.builtinSkills?.directories ?? [];
    if (skillDirectories.length) launch += `:skills:${JSON.stringify(skillDirectories)}`;
    key += launch;
    // Everything a scoped server is started with except the session's credential. Its
    // environment is compared separately.
    const configuration = ctx.instanceId === undefined ? `default${launch}` : key;
    // ace's MCP server is one name per location, so a process serves one session's bearer.
    // Never share it between sessions.
    if (connection) key = `mcp:${++this.serial}`;
    const accountKey = key;
    const selectGeneration = () => {
      const matching = [...this.entries].find(
        ([, candidate]) =>
          candidate.accountKey === accountKey && sameEnvironment(candidate.env, env),
      );
      return (
        matching?.[0] ??
        (this.entries.has(accountKey) ? `${accountKey}:environment:${++this.serial}` : accountKey)
      );
    };
    key = selectGeneration();
    // A last-user release owns shutdown. Reopening the same account waits for confirmed
    // exit, so it cannot borrow a closing server or accumulate retired native processes.
    while (this.entries.get(key)?.closing) {
      await this.entries.get(key)?.closing;
      this.assertOpen();
      key = selectGeneration();
    }
    const credentialFree: ServerOptions = {
      ...this.options,
      discovery: {
        ...this.options.discovery,
        ...(env ? { env } : {}),
        ...(ctx.executable
          ? { overrides: { ...this.options.discovery?.overrides, opencode: ctx.executable } }
          : {}),
      },
      ...(skillDirectories.length ? { skillDirectories } : {}),
      ...(connection ? { mcpReadyPlugin: mcpReadyPluginDirectory() } : {}),
    };
    const serverOptions: ServerOptions = connection
      ? { ...credentialFree, secrets: [...(this.options.secrets ?? []), connection.bearer] }
      : credentialFree;
    // Taken only once the session has a place, so a refused open never strands a running spare.
    const server = () => {
      const spare = connection ? this.takeSpare(configuration, env) : undefined;
      // A spare never served anyone: it gets this session's credential and nothing else's.
      if (spare && connection) spare.addSecret(connection.bearer);
      return spare ?? new OpenCodeServer(serverOptions);
    };
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 128) {
        const idle = [...this.entries].find(
          ([, candidate]) => candidate.users === 0 && !candidate.scoped,
        );
        if (!idle) throw new Error("OpenCode instance limit reached");
        this.entries.delete(idle[0]);
        // Reserve the replacement before awaiting shutdown, keeping concurrent opens bounded.
        entry = {
          accountKey,
          server: server(),
          env,
          users: 1,
          scoped: !!connection,
        };
        this.entries.set(key, entry);
        await idle[1].server.close();
      } else {
        entry = {
          accountKey,
          server: server(),
          env,
          users: 1,
          scoped: !!connection,
        };
        this.entries.set(key, entry);
      }
    } else entry.users++;
    if (this.closed) {
      entry.users--;
      throw new Error("OpenCode adapter is closed");
    }
    const acquired = entry;
    let released = false;
    if (connection) this.extendSpare(configuration);
    return {
      server: acquired.server,
      opened: () => {
        if (connection) this.warm(configuration, env, credentialFree);
      },
      release: () => {
        if (!released) {
          released = true;
          acquired.users--;
          if (connection) this.extendSpare(configuration);
        }
        if (acquired.users > 0) return Promise.resolve();
        acquired.closing ??= acquired.server.close().then(() => {
          if (this.entries.get(key) === acquired) this.entries.delete(key);
        });
        return acquired.closing;
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    const spares = [...this.spares.values()];
    this.spares.clear();
    for (const spare of spares) spare.expire();
    await Promise.all([...this.entries.values(), ...spares].map((holder) => holder.server.close()));
    this.entries.clear();
  }
  /**
   * Starts one credential-free server for the next scoped session with this configuration,
   * after a session's own server is up, so the two never start at once.
   */
  private warm(configuration: string, env: NodeJS.ProcessEnv | undefined, options: ServerOptions) {
    const current = this.spares.get(configuration);
    if (this.closed || (current && sameEnvironment(current.env, env))) return;
    if (current) this.retireSpare(configuration);
    if (this.spares.size >= spareLimit) return;
    const server = new OpenCodeServer(options);
    const spare: Spare = { server, env, expire: () => {} };
    this.spares.set(configuration, spare);
    this.extendSpare(configuration);
    // A spare that cannot start is dropped; the next session starts its own server as before.
    void server.ready().catch(() => {
      if (this.spares.get(configuration) === spare) this.retireSpare(configuration);
    });
  }
  private takeSpare(
    configuration: string,
    env: NodeJS.ProcessEnv | undefined,
  ): OpenCodeServer | undefined {
    const spare = this.spares.get(configuration);
    if (!spare || !sameEnvironment(spare.env, env)) return undefined;
    this.spares.delete(configuration);
    spare.expire();
    return spare.server;
  }
  /** A spare stops once its configuration has seen no session open or close for a while. */
  private extendSpare(configuration: string): void {
    const spare = this.spares.get(configuration);
    if (!spare) return;
    spare.expire();
    const scheduled = runtime(this.options.runtime).schedule(() => {
      if (this.spares.get(configuration) === spare) this.retireSpare(configuration);
    }, spareIdleMs);
    spare.expire = scheduled;
  }
  private retireSpare(configuration: string): void {
    const spare = this.spares.get(configuration);
    if (!spare) return;
    this.spares.delete(configuration);
    spare.expire();
    void spare.server.close().catch(() => {});
  }
}
function sameEnvironment(
  a: NodeJS.ProcessEnv | undefined,
  b: NodeJS.ProcessEnv | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
