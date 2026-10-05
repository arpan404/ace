import { z } from "zod";
import type { SpawnOptions, SupervisedProcess } from "@ace/provider-kit/process";
import type { ModelInstance } from "./types.ts";

/** OpenCode v2's own credential-free status command, including environment connections. */
export async function connectedOpenCodeProviders(
  instance: ModelInstance,
  signal: AbortSignal,
  spawn: (options: SpawnOptions) => SupervisedProcess,
): Promise<ReadonlySet<string>> {
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
    const rows = z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            connections: z.array(z.object({ type: z.string() }).passthrough()).max(128),
          })
          .passthrough(),
      )
      .max(512)
      .parse(JSON.parse(output));
    return new Set(
      rows
        .filter((row) =>
          row.connections.some(
            (connection) => connection.type === "credential" || connection.type === "env",
          ),
        )
        .map((row) => row.id),
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  }
}
