import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Runs a real child that guards its console, logs every way a dependency might, then answers. */
async function guardedChild(guard: "routeConsoleToStderr" | "silenceConsole") {
  const dir = await mkdtemp(join(tmpdir(), "console-guard-"));
  dirs.push(dir);
  const script = join(dir, "child.ts");
  await writeFile(
    script,
    `import { ${guard} } from ${JSON.stringify(new URL("./console-guard.ts", import.meta.url).pathname)};
${guard}();
console.log("log line");
console.info("info line");
console.debug("debug line", { detail: true });
console.dir({ dir: "line" });
console.table([{ table: 1 }]);
console.error("error line");
console.warn("warn line");
// Bun-only writers that also print straight to fd 1.
const bun = console as unknown as { write?(text: string): number; takeHeapSnapshot?(): void };
bun.write?.("write line\\n");
bun.takeHeapSnapshot?.();
process.stdout.write(JSON.stringify({ reply: true }) + "\\n");
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  // "close" waits for both pipes to drain; output can still arrive after "exit".
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

// Bun's console writes to fd 1 directly, so a dependency's log once broke a protocol stream.
it("console output in a guarded child goes to stderr, never into its stdout protocol stream", async () => {
  const { code, stdout, stderr } = await guardedChild("routeConsoleToStderr");
  expect(code).toBe(0);
  expect(stdout).toBe('{"reply":true}\n');
  for (const line of ["log line", "info line", "debug line", "dir", "table", "error line"])
    expect(stderr).toContain(line);
  expect(stderr).toContain("warn line");
  if ("Bun" in globalThis) expect(stderr).toContain("write line");
});

it("a silenced child's console output reaches neither stdout nor stderr", async () => {
  const { code, stdout, stderr } = await guardedChild("silenceConsole");
  expect(code).toBe(0);
  expect(stdout).toBe('{"reply":true}\n');
  expect(stderr).toBe("");
});
