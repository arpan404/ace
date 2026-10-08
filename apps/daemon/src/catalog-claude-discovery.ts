import { spawnSupervised } from "@ace/provider-kit/process";
import { claudePluginCatalog } from "@ace/commands";
import type { CatalogEntry } from "@ace/protocol";
/** A bounded CLI registry read. This command neither starts a model session nor changes installation. */
export async function discoverClaudePlugins(options: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<CatalogEntry[]> {
  options.signal.throwIfAborted();
  const proc = spawnSupervised({
    command: options.executable,
    args: ["plugin", "list", "--json"],
    cwd: options.cwd,
    env: options.env,
    name: "claude-extension-discovery",
    maxOutputBytes: 4 * 1024 * 1024,
    maxLineBytes: 1024 * 1024,
  });
  const chunks: string[] = [];
  let bytes = 0;
  const stop = () => {
    void proc.stop({ graceMs: 0 });
  };
  const deadline = setTimeout(stop, 5000);
  options.signal.addEventListener("abort", stop, { once: true });
  proc.stdout.on("line", (line: string) => {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > 4 * 1024 * 1024) stop();
    else chunks.push(line);
  });
  try {
    const exit = await proc.exited;
    options.signal.throwIfAborted();
    if (exit.code !== 0 || bytes > 4 * 1024 * 1024) return [];
    const value: unknown = JSON.parse(chunks.join("\n"));
    return claudePluginCatalog(value, options.cwd);
  } finally {
    clearTimeout(deadline);
    options.signal.removeEventListener("abort", stop);
    await proc.stop({ graceMs: 0 });
  }
}
