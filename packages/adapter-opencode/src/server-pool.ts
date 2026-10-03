import { z } from "zod";
import type { SessionContext } from "@ace/engine-api";
import { OpenCodeServer, type ServerOptions } from "./server.ts";
import { AceMcpConnectionSchema } from "@ace/mcp-server";
import { mcpEnvironment } from "./mcp-environment.ts";
const Environment = z
  .record(z.string().max(256), z.string().max(32768).optional())
  .refine((env) => Object.keys(env).length <= 512);
type Entry = { server: OpenCodeServer; env: NodeJS.ProcessEnv | undefined; users: number };
/** Accounts share transport unless process-wide configuration carries a scoped MCP lease. */
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
  async acquire(ctx: SessionContext): Promise<{ server: OpenCodeServer; release(): void }> {
    if (this.closed) throw new Error("OpenCode adapter is closed");
    const connection = ctx.aceMcp ? AceMcpConnectionSchema.parse(ctx.aceMcp) : undefined;
    const env = connection
      ? Environment.parse(
          mcpEnvironment(
            Environment.parse({ ...process.env, ...this.options.discovery?.env, ...ctx.env }),
            connection,
          ),
        )
      : ctx.env === undefined
        ? undefined
        : Environment.parse(ctx.env);
    let key =
      ctx.instanceId === undefined
        ? "default"
        : `account:${z.string().min(1).max(512).parse(ctx.instanceId)}`;
    if (ctx.instanceId === undefined && ctx.env) {
      key = this.anonymous.get(ctx.env) ?? `anonymous:${++this.serial}`;
      this.anonymous.set(ctx.env, key);
    }
    // A process-wide MCP config must never share one thread's authority with another.
    if (connection) key = `${key}:lease:${connection.bearer}`;
    const secrets = connection ? [connection.bearer] : [];
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
            ...(connection ? { redactSecrets: secrets } : {}),
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
            ...(connection ? { redactSecrets: secrets } : {}),
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
