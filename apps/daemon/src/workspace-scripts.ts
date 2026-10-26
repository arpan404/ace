import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WorkspaceScript, type WorkspaceScript as Script } from "@ace/protocol";

/** Read only bounded regular root files, without following symlinks or waiting on FIFOs. */
export async function readScriptFile(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 262144) throw new Error("script_file_limit");
    const buffer = Buffer.alloc(262145);
    let size = 0;
    while (size < buffer.length) {
      const chunk = await file.read(buffer, size, buffer.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > 262144) throw new Error("script_file_limit");
    return buffer.toString("utf8", 0, size);
  } finally {
    await file.close();
  }
}
export function scriptsFromFiles(
  files: Readonly<Record<string, string | undefined>>,
  manager: "bun" | "npm" | "pnpm" | "yarn",
): Script[] {
  const scripts: Script[] = [];
  // Past the listing limit, further entries are left out; one bad entry never hides the rest.
  const add = (source: Script["source"], name: string, command: string) => {
    if (scripts.length >= 256) return;
    const script = WorkspaceScript.safeParse({ id: `${source}:${name}`, source, name, command });
    if (script.success) scripts.push(script.data);
  };
  const pkg = packageScripts(files["package.json"]);
  for (const name of Object.keys(pkg))
    add("package.json", name, `${manager} run ${shellQuote(name)}`);
  for (const line of files.Procfile?.split("\n") ?? []) {
    const match = /^([\w.-]+):\s*(.+)$/.exec(line);
    if (match?.[1] && match[2]) add("Procfile", match[1], match[2]);
  }
  for (const source of ["Makefile", "justfile"] as const)
    for (const line of files[source]?.split("\n") ?? []) {
      const match =
        source === "Makefile"
          ? /^([a-zA-Z][\w.-]*):(?:[^=]|$)/.exec(line)
          : /^([a-zA-Z][\w.-]*)(?:\s+[^:=]*)?:/.exec(line);
      if (match?.[1])
        add(source, match[1], `${source === "Makefile" ? "make" : "just"} ${shellQuote(match[1])}`);
    }
  return scripts;
}
/** A malformed package.json lists no scripts instead of failing every script lookup. */
function packageScripts(text: string | undefined): Record<string, string> {
  if (!text) return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  const pkg = z.object({ scripts: z.record(z.string(), z.unknown()).optional() }).safeParse(json);
  if (!pkg.success) return {};
  return Object.fromEntries(
    Object.entries(pkg.data.scripts ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
export async function listScripts(root: string): Promise<Script[]> {
  const names = ["package.json", "Procfile", "Makefile", "justfile"];
  const files = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readScriptFile(join(root, name))])),
  );
  let manager: "bun" | "npm" | "pnpm" | "yarn" = "npm";
  for (const [lock, candidate] of [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ] as const) {
    try {
      if ((await lstat(join(root, lock))).isFile()) {
        manager = candidate;
        break;
      }
    } catch {
      /* Missing lock. */
    }
  }
  return scriptsFromFiles(files, manager);
}
