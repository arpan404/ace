import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/** cmd.exe expands `%`, so literal text in a batch line doubles it. */
const batchLiteral = (text: string) => text.replaceAll("%", "%%");

/**
 * A Windows launcher for a fake provider CLI, shaped like the `.cmd` shim npm installs:
 * cmd.exe runs it and it forwards every argument to Node running `script`. Launching a fake
 * through it takes the same batch path (cmd.exe wrapping, `%*` reparse) as a real install.
 * `preload` runs first in the same Node process.
 */
export async function writeCmdShim(
  directory: string,
  name: string,
  script: string,
  preload?: string,
): Promise<string> {
  // A quote would end the quoted path early instead of reaching Node.
  if (`${process.execPath}${script}${preload ?? ""}`.includes('"'))
    throw new Error("A cmd shim path cannot contain a quote");
  const imports = preload ? ` --import "${batchLiteral(pathToFileURL(preload).href)}"` : "";
  const line = `@"${batchLiteral(process.execPath)}"${imports} "${batchLiteral(script)}" %*`;
  const path = join(directory, `${name}.cmd`);
  await writeFile(path, `${line}\r\n`);
  return path;
}

/**
 * A preload that makes the fake ignore its stdin lease and polite stops, with a grandchild in
 * its tree. Both pids are written to `ACE_TEST_TREE_PIDS`.
 */
export async function stubbornTree(directory: string): Promise<string> {
  const path = join(directory, "stubborn-tree.mjs");
  await writeFile(
    path,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {',
      '  stdio: "ignore",',
      "  windowsHide: true,",
      "});",
      "writeFileSync(process.env.ACE_TEST_TREE_PIDS, JSON.stringify({ agent: process.pid, child: child.pid }));",
      "setInterval(() => {}, 1 << 30);",
      "",
    ].join("\n"),
  );
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Whether `pid` has ended within `ms`; a tree stop can finish just after the leader's exit. */
export async function ended(pid: number, ms = 10_000): Promise<boolean> {
  for (const until = performance.now() + ms; performance.now() < until; await delay(50))
    if (!alive(pid)) return true;
  return !alive(pid);
}
