import { z } from "zod";
import type { SpawnOptions, SupervisedProcess } from "@ace/provider-kit/process";
import { providerSource } from "./model-source.ts";
import type { ModelSource } from "@ace/protocol";
import type { ModelInstance } from "./types.ts";

/** OpenCode v2's own credential-free status command, including environment connections. */
export async function connectedOpenCodeProviders(
  instance: ModelInstance,
  signal: AbortSignal,
  spawn: (options: SpawnOptions) => SupervisedProcess,
): Promise<ReadonlyMap<string, ModelSource>> {
  signal.throwIfAborted();
  const proc = spawn({
    command: instance.executable,
    args: [...instance.args, "auth", "list", "--standalone", "--format", "json"],
    cwd: instance.cwd,
    env: instance.env,
    name: "opencode-connections",
    maxOutputBytes: 1024 * 1024,
  });
  let output = "";
  proc.stdout.on("line", (line: string) => {
    output += line + "\n";
  });
  const abort = () => {
    void proc.stop({ graceMs: 0 });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const exit = await proc.exited;
    signal.throwIfAborted();
    if (exit.reason !== "exit" || exit.code !== 0)
      throw new Error("OpenCode connection status unavailable");
    return parseOpenCodeConnections(JSON.parse(output));
  } finally {
    signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  }
}

/** Only CLI-exposed identity/type/endpoint flags cross this boundary. Unknown fields are stripped. */
export function parseOpenCodeConnections(value: unknown): ReadonlyMap<string, ModelSource> {
  const rows = z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        name: z.string().min(1).max(256).optional(),
        local: z.boolean().optional(),
        baseURL: z.string().max(4096).optional(),
        connections: z
          .array(z.object({ type: z.string().max(256), authType: z.string().max(256).optional() }))
          .max(128),
      }),
    )
    .max(512)
    .parse(value);
  const connected = new Map<string, ModelSource>();
  for (const row of rows) {
    const source = providerSource(row.id, {
      ...row,
      types: row.connections.map((connection) => connection.type),
      authType: row.connections.find((connection) => connection.authType)?.authType,
    });
    if (row.connections.length || source.kind === "local") connected.set(row.id, source);
  }
  return connected;
}
