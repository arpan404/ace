import { mcpReadyPluginDirectory } from "./mcp-ready.ts";
import { z } from "zod";
import type { SessionContext } from "@ace/engine-api";
import { OpenCodeServer, type ServerOptions } from "./server.ts";
import { installationIdentity } from "./installation.ts";
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
type Spare = { server: OpenCodeServer; env: NodeJS.ProcessEnv | undefined };
/** Spares plus retired servers still shutting down. */
const spareLimit = 8;
/** Account identity owns transport lifetime; a session's abort owns only that session. */
export class ServerPool {
  private entries = new Map<string, Entry>();
  private spares = new Map<string, Spare>();
  /** Open scoped sessions per configuration. A spare lives only while its count is above 0. */
  private live = new Map<string, number>();
  /** Servers whose shutdown has started but not finished; close and the cap wait for them. */
  private retiring = new Set<Promise<void>>();
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
    // A spare never served anyone: it gets this session's credential and nothing else's.
    const spare = connection ? await this.takeSpare(configuration, env) : undefined;
    if (spare && connection) spare.addSecret(connection.bearer);
    const server = () => spare ?? new OpenCodeServer(serverOptions);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 128) {
        const idle = [...this.entries].find(
          ([, candidate]) => candidate.users === 0 && !candidate.scoped,
        );
        if (!idle) {
          // A refused open never strands a running spare.
          if (spare) await this.retire(spare);
          throw new Error("OpenCode instance limit reached");
        }
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
      if (spare) await this.retire(spare);
      throw new Error("OpenCode adapter is closed");
    }
    const acquired = entry;
    let left: Promise<void> | undefined;
    if (connection) this.live.set(configuration, (this.live.get(configuration) ?? 0) + 1);
    return {
      server: acquired.server,
      opened: () => {
        if (connection && !left) this.warm(configuration, env, credentialFree);
      },
      release: () => {
        if (!left) {
          acquired.users--;
          left = connection ? this.leave(configuration) : Promise.resolve();
        }
        if (acquired.users > 0) return left;
        acquired.closing ??= acquired.server.close().then(() => {
          if (this.entries.get(key) === acquired) this.entries.delete(key);
        });
        return Promise.all([acquired.closing, left]).then(() => {});
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    const spares = [...this.spares.values()];
    this.spares.clear();
    await Promise.all([
      ...[...this.entries.values()].map((entry) => entry.server.close()),
      ...spares.map((spare) => this.retire(spare.server)),
      ...this.retiring,
    ]);
    this.entries.clear();
  }
  /**
   * Starts one credential-free server for the next scoped session with this configuration,
   * after a session's own server is up, so the two never start at once.
   */
  private warm(configuration: string, env: NodeJS.ProcessEnv | undefined, options: ServerOptions) {
    const current = this.spares.get(configuration);
    if (this.closed || !this.live.get(configuration)) return;
    if (current && sameEnvironment(current.env, env)) return;
    if (current) this.retireSpare(configuration);
    if (this.spares.size + this.retiring.size >= spareLimit) return;
    const server = new OpenCodeServer(options);
    const spare: Spare = { server, env };
    this.spares.set(configuration, spare);
    // A spare that cannot start is dropped; the next session starts its own server as before.
    void server.ready().catch(() => {
      if (this.spares.get(configuration) === spare) this.retireSpare(configuration);
    });
  }
  /**
   * The spare for this configuration, if it still runs the installation discovery found for
   * it. An update, reinstall or retargeted link since then retires it instead.
   */
  private async takeSpare(
    configuration: string,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<OpenCodeServer | undefined> {
    const spare = this.spares.get(configuration);
    if (!spare || !sameEnvironment(spare.env, env)) return undefined;
    this.spares.delete(configuration);
    // A spare still discovering resolves its executable now, like a server started here would.
    const installed = spare.server.installedAs;
    if (installed && (await installationIdentity(installed.path)) !== installed.identity) {
      // Counted until it exits; this session need not wait for that.
      void this.retire(spare.server);
      return undefined;
    }
    return spare.server;
  }
  /**
   * A scoped session left. With it the last of its configuration, the spare stops too, and the
   * release waits for it: an account change that stops the account's sessions finds no
   * process of that account still running.
   */
  private leave(configuration: string): Promise<void> {
    const remaining = (this.live.get(configuration) ?? 1) - 1;
    if (remaining > 0) {
      this.live.set(configuration, remaining);
      return Promise.resolve();
    }
    this.live.delete(configuration);
    return this.retireSpare(configuration);
  }
  private retireSpare(configuration: string): Promise<void> {
    const spare = this.spares.get(configuration);
    if (!spare) return Promise.resolve();
    this.spares.delete(configuration);
    return this.retire(spare.server);
  }
  /** Stops a server no session holds, counted until its process has exited. */
  private retire(server: OpenCodeServer): Promise<void> {
    const stopped = server.close().catch(() => {});
    this.retiring.add(stopped);
    void stopped.then(() => this.retiring.delete(stopped));
    return stopped;
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
