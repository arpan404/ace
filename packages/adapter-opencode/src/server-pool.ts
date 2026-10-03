import { z } from "zod";
import type { SessionContext } from "@ace/engine-api";
import { OpenCodeServer, type ServerOptions } from "./server.ts";
const Environment = z
  .record(z.string().max(256), z.string().max(32768).optional())
  .refine((env) => Object.keys(env).length <= 512);
type Entry = { server: OpenCodeServer; env: NodeJS.ProcessEnv | undefined; users: number };
/** Account identity owns transport lifetime; a session's abort owns only that session. */
export class ServerPool {
  private entries = new Map<string, Entry>();
  private anonymous = new WeakMap<NodeJS.ProcessEnv, string>();
  private mcp = new WeakMap<NonNullable<SessionContext["aceMcp"]>, string>();
  private serial = 0;
  private closed = false;
  constructor(privateOptions: ServerOptions) {
    this.options = privateOptions;
  }
  private options: ServerOptions;
  assertOpen(): void {
    if (this.closed) throw new Error("OpenCode adapter is closed");
  }
  async acquire(ctx: SessionContext): Promise<{ server: OpenCodeServer; release(): void }> {
    if (this.closed) throw new Error("OpenCode adapter is closed");
    const env = ctx.env === undefined ? undefined : Environment.parse(ctx.env);
    let key =
      ctx.instanceId === undefined
        ? "default"
        : `account:${z.string().min(1).max(512).parse(ctx.instanceId)}`;
    // MCP credentials are scoped to one engine session. Never reuse another thread's overlay,
    // even within the same account. Weak identities do not retain expired lease objects.
    if (ctx.aceMcp) {
      const identity = this.mcp.get(ctx.aceMcp) ?? `mcp:${++this.serial}`;
      this.mcp.set(ctx.aceMcp, identity);
      key = `${key}:${identity}`;
    } else if (ctx.instanceId === undefined && ctx.env) {
      key = this.anonymous.get(ctx.env) ?? `anonymous:${++this.serial}`;
      this.anonymous.set(ctx.env, key);
    }
    let entry = this.entries.get(key);
    if (entry && !sameEnvironment(entry.env, env))
      throw new Error("OpenCode account environment changed");
    if (!entry) {
      if (this.entries.size >= 128) {
        const idle = [...this.entries].find(([, candidate]) => candidate.users === 0);
        if (!idle) throw new Error("OpenCode instance limit reached");
        this.entries.delete(idle[0]);
        // Reserve the replacement before awaiting shutdown, keeping concurrent opens bounded.
        entry = {
          server: new OpenCodeServer({
            ...this.options,
            discovery: { ...this.options.discovery, ...(env ? { env } : {}) },
          }),
          env,
          users: 1,
        };
        this.entries.set(key, entry);
        await idle[1].server.close();
      } else {
        entry = {
          server: new OpenCodeServer({
            ...this.options,
            discovery: { ...this.options.discovery, ...(env ? { env } : {}) },
          }),
          env,
          users: 1,
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
