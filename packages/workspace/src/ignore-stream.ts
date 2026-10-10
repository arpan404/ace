import type { ChildProcess } from "node:child_process";
import type { SafeRoot } from "./safety.ts";
import { WorkspaceError, aborted } from "./types.ts";

/** One interactive Git process per reconciliation, with one bounded batch in flight. */
export function ignoreStream(safe: SafeRoot, signal: AbortSignal) {
  aborted(signal);
  const child: ChildProcess = safe.runtime.spawn(
    "git",
    ["check-ignore", "--stdin", "-z", "--verbose", "--non-matching"],
    {
      cwd: safe.root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_FLUSH: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let pending:
    | {
        remaining: number;
        ignored: Set<string>;
        resolve(value: Set<string>): void;
        reject(error: unknown): void;
      }
    | undefined;
  let buffer = "";
  const fields: string[] = [];
  let problem: unknown;
  let stderr = "";
  let ending = false;
  const decoder = new TextDecoder();
  const fail = (error: unknown) => {
    problem = error;
    pending?.reject(error);
    pending = undefined;
    child.kill("SIGKILL");
  };
  const abort = () => fail(new WorkspaceError("ABORTED", "Workspace ignore scan cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  child.on("error", fail);
  child.stdin?.on("error", fail);
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(0, 8192);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1_048_576) {
      fail(new WorkspaceError("LIMIT_EXCEEDED", "Ignore response exceeded its budget"));
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\0")) >= 0) {
      fields.push(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (fields.length !== 4) continue;
      const batch = pending;
      if (!batch) {
        fail(new WorkspaceError("IO_ERROR", "Unexpected ignore response"));
        return;
      }
      const pattern = fields[2] ?? "",
        path = fields[3] ?? "";
      if (pattern && !pattern.startsWith("!")) batch.ignored.add(path);
      fields.length = 0;
      if (--batch.remaining === 0) {
        pending = undefined;
        batch.resolve(batch.ignored);
      }
    }
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", (code) => {
      if (!ending || pending)
        fail(new WorkspaceError("IO_ERROR", stderr || `Ignore process exited with ${code}`));
      signal.removeEventListener("abort", abort);
      resolve();
    }),
  );
  return {
    async ignored(paths: string[]): Promise<Set<string>> {
      aborted(signal);
      if (problem) throw problem;
      if (!paths.length) return new Set();
      if (pending) throw new WorkspaceError("IO_ERROR", "Concurrent ignore batches");
      if (!child.stdin) throw new WorkspaceError("IO_ERROR", "Ignore process requires input");
      const result = new Promise<Set<string>>((resolve, reject) => {
        pending = { remaining: paths.length, ignored: new Set(), resolve, reject };
      });
      child.stdin.write(paths.join("\0") + "\0");
      return result;
    },
    async close() {
      ending = true;
      child.stdin?.end();
      await closed;
    },
  };
}
