import { constants } from "node:fs";
import { open, access, stat, lstat } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { z } from "zod";
import {
  WorkspaceScript,
  InstalledEditor,
  type WorkspaceScript as Script,
  type InstalledEditor as Editor,
} from "@ace/protocol";

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
  const add = (source: Script["source"], name: string, command: string) => {
    if (scripts.length >= 256) throw new Error("script_count_limit");
    scripts.push(WorkspaceScript.parse({ id: `${source}:${name}`, source, name, command }));
  };
  if (files["package.json"]) {
    const pkg = z
      .object({ scripts: z.record(z.string().min(1).max(128), z.string().max(8192)).optional() })
      .parse(JSON.parse(files["package.json"]));
    for (const [name] of Object.entries(pkg.scripts ?? {}))
      add("package.json", name, `${manager} run ${shellQuote(name)}`);
  }
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
export async function installedEditors(
  paths: string | undefined,
  platform: NodeJS.Platform,
  applications: readonly string[] = [],
): Promise<Editor[]> {
  const found: Editor[] = [];
  for (const [id, name] of [
    ["code", "Visual Studio Code"],
    ["cursor", "Cursor"],
    ["zed", "Zed"],
    ["subl", "Sublime Text"],
    ["idea", "IntelliJ IDEA"],
  ]) {
    if (!id || !name) continue;
    const candidates = (paths ?? "")
      .split(delimiter)
      .filter(Boolean)
      .slice(0, 128)
      .map((directory) => join(directory, platform === "win32" ? `${id}.cmd` : id));
    const bundle = macEditorBundles[id];
    if (platform === "darwin" && bundle)
      for (const directory of applications.slice(0, 8)) candidates.push(join(directory, bundle));
    for (const command of candidates) {
      try {
        if (!(await stat(command)).isFile()) continue;
        await access(command, platform === "win32" ? constants.F_OK : constants.X_OK);
        found.push(InstalledEditor.parse({ id, name, command }));
        break;
      } catch {
        /* Not installed at this path. */
      }
    }
  }
  return found;
}

const macEditorBundles: Record<string, string> = {
  code: "Visual Studio Code.app/Contents/Resources/app/bin/code",
  cursor: "Cursor.app/Contents/Resources/app/bin/cursor",
  zed: "Zed.app/Contents/MacOS/cli",
  subl: "Sublime Text.app/Contents/SharedSupport/bin/subl",
  idea: "IntelliJ IDEA.app/Contents/MacOS/idea",
};
