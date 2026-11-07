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

const OpenCodeConnectionRows = z
  .array(
    z.object({
      id: z.string().min(1).max(256),
      name: z.string().min(1).max(256).optional(),
      local: z.boolean().optional(),
      baseURL: z.string().max(4096).optional(),
      connections: z
        .array(
          z.object({
            type: z.string().max(256),
            // OpenCode 2.2 names the sign-in method `method`; older builds used `authType`.
            authType: z.string().max(256).optional(),
            method: z.string().max(256).optional(),
          }),
        )
        .max(128),
    }),
  )
  .max(512);

/** Only CLI-exposed identity/type/endpoint flags cross this boundary. Unknown fields are stripped. */
export function parseOpenCodeConnections(value: unknown): ReadonlyMap<string, ModelSource> {
  const rows = OpenCodeConnectionRows.parse(value);
  const connected = new Map<string, ModelSource>();
  for (const row of rows) {
    const source = providerSource(row.id, {
      ...row,
      types: row.connections.map((connection) => connection.type),
      authType: row.connections
        .map((connection) => connection.authType ?? connection.method)
        .find(Boolean),
    });
    if (row.connections.length || source.kind === "local") connected.set(row.id, source);
  }
  return connected;
}

/**
 * An OpenCode Console login is one `opencode` row, yet the same account may also serve Go.
 * Go is then only a candidate: it joins the catalog through the models the CLI serves for it,
 * so an account without Go gets no empty Go group.
 */
export function impliedOpenCodeProviders(
  connected: ReadonlyMap<string, ModelSource>,
): ReadonlyMap<string, ModelSource> {
  const zen = connected.get("opencode");
  if (!zen || zen.kind === "local" || connected.has("opencode-go")) return new Map();
  return new Map([["opencode-go", providerSource("opencode-go")]]);
}
