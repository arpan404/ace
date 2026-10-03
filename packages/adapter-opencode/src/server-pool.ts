import { z } from "zod";
import { openCodeInjection } from "@ace/mcp-server";
import type { SessionContext } from "@ace/engine-api";
import { OpenCodeServer, type ServerOptions } from "./server.ts";
const Environment = z
  .record(z.string().max(256), z.string().max(32768).optional())
  .refine((env) => Object.keys(env).length <= 512);
type Entry = {
  server: OpenCodeServer;
  env: NodeJS.ProcessEnv | undefined;
  users: number;
  scoped: boolean;
  closing?: Promise<void>;
};
/** Account identity owns transport lifetime; a session's abort owns only that session. */
export class ServerPool {
  private entries = new Map<string, Entry>();
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
  async acquire(
    ctx: SessionContext,
  ): Promise<{ server: OpenCodeServer; release(): Promise<void> }> {
    if (this.closed) throw new Error("OpenCode adapter is closed");
    const supplied = ctx.env === undefined ? undefined : Environment.parse(ctx.env);
    const injection = ctx.aceMcp
      ? openCodeInjection(
          ctx.aceMcp,
          supplied?.["OPENCODE_CONFIG_CONTENT"] ??
            this.options.discovery?.env?.["OPENCODE_CONFIG_CONTENT"],
        )
      : undefined;
    if (injection && this.options.attach)
      throw new Error(
        "Scoped ace MCP requires an owned OpenCode server; external attachment cannot isolate session credentials",
      );
    const env = injection
      ? Environment.parse({ ...this.options.discovery?.env, ...supplied, ...injection.env })
      : supplied;
    let key =
      ctx.instanceId === undefined
        ? "default"
        : `account:${z.string().min(1).max(512).parse(ctx.instanceId)}`;
    if (ctx.instanceId === undefined && ctx.env) {
      key = this.anonymous.get(ctx.env) ?? `anonymous:${++this.serial}`;
      this.anonymous.set(ctx.env, key);
    }
    // Native MCP config is process-wide. Never share its bearer between sessions.
    if (injection) key = `mcp:${++this.serial}`;
    const serverOptions: ServerOptions = {
      ...this.options,
      discovery: { ...this.options.discovery, ...(env ? { env } : {}) },
      ...(ctx.aceMcp ? { secrets: [...(this.options.secrets ?? []), ctx.aceMcp.bearer] } : {}),
    };
    let entry = this.entries.get(key);
    if (entry && !sameEnvironment(entry.env, env))
      throw new Error("OpenCode account environment changed");
    if (!entry) {
      if (this.entries.size >= 128) {
        const idle = [...this.entries].find(
          ([, candidate]) => candidate.users === 0 && !candidate.scoped,
        );
        if (!idle) throw new Error("OpenCode instance limit reached");
        this.entries.delete(idle[0]);
        // Reserve the replacement before awaiting shutdown, keeping concurrent opens bounded.
        entry = {
          server: new OpenCodeServer(serverOptions),
          env,
          users: 1,
          scoped: !!injection,
        };
        this.entries.set(key, entry);
        await idle[1].server.close();
      } else {
        entry = {
          server: new OpenCodeServer(serverOptions),
          env,
          users: 1,
          scoped: !!injection,
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
    return {
      server: acquired.server,
      release: () => {
        if (!released) {
          released = true;
          acquired.users--;
        }
        if (!acquired.scoped) return Promise.resolve();
        acquired.closing ??= acquired.server.close().then(() => {
          if (this.entries.get(key) === acquired) this.entries.delete(key);
        });
        return acquired.closing;
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.values()].map((entry) => entry.server.close()));
    this.entries.clear();
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
