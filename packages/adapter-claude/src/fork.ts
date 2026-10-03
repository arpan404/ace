import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSupervised } from "@ace/provider-kit/process";
import { z } from "zod";

/** Idle transcript clone. Never spawns a provider CLI, sends input or copies file undo history. */
export async function forkClaudeSession(input: {
  nativeSessionId: string;
  home: string;
  configDir?: string;
  signal: AbortSignal;
}): Promise<string> {
  const source = z.uuid().parse(input.nativeSessionId);
  if (!isAbsolute(input.home) || (input.configDir !== undefined && !isAbsolute(input.configDir)))
    throw new Error("Claude fork requires an absolute account home");
  input.signal.throwIfAborted();
  const worker = spawnSupervised({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fork-worker.ts", import.meta.url)), source],
    env: { HOME: input.home, CLAUDE_CONFIG_DIR: input.configDir ?? join(input.home, ".claude") },
    name: "claude-history-fork",
    maxLineBytes: 4096,
    maxOutputBytes: 8192,
  });
  let nativeId: string | undefined;
  let failure: unknown;
  worker.stdout.on("line", (line) => {
    try {
      const result = z.object({ sessionId: z.uuid() }).parse(JSON.parse(line));
      if (nativeId !== undefined || result.sessionId === source)
        throw new Error("Invalid Claude fork identity");
      nativeId = result.sessionId;
    } catch (error) {
      failure = error;
    }
  });
  const abort = () => {
    void worker.stop({ graceMs: 0 });
  };
  input.signal.addEventListener("abort", abort, { once: true });
  // Filesystem operations are bounded even if an account's filesystem stops responding.
  const deadline = setTimeout(abort, 15_000);
  try {
    const exit = await worker.exited;
    input.signal.throwIfAborted();
    if (failure) throw failure;
    if (exit.code !== 0 || nativeId === undefined)
      throw new Error("Claude idle history fork failed");
    return nativeId;
  } finally {
    clearTimeout(deadline);
    input.signal.removeEventListener("abort", abort);
    await worker.stop({ graceMs: 0 });
  }
}
