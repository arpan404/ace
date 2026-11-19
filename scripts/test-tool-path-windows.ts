import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { versionManagerShim } from "@ace/provider-kit/discovery";
import { forbiddenTools } from "./test-tool-path.ts";

/** A PATH folder and the file names in it. */
export type WindowsDirectory = { directory: string; names: readonly string[] };

/**
 * A Windows test PATH: the tool folder first, then the folders kept whole. A tool is a `copy`
 * (an `.exe` or `.com`, which a bare-name CreateProcess finds) or a `.cmd` `wrapper` that calls
 * the original script.
 */
export type WindowsToolPlan = {
  keep: string[];
  tools: { name: string; target: string; kind: "copy" | "wrapper" }[];
};

/**
 * The POSIX policy under Windows' rules, without links (they need privileges). A folder of
 * version-manager shims is dropped. A folder holding an agent CLI (npm's global bin, `bun -g`'s)
 * is dropped too, and its other commands are carried into the tool folder one by one. Every
 * other folder is kept whole. A command an earlier folder already provides stays shadowed, as
 * on the person's PATH, and the runtime running the tests comes first.
 */
export function planWindowsToolPath(
  entries: readonly WindowsDirectory[],
  pathext: readonly string[],
  runtime: string,
): WindowsToolPlan {
  const extensions = new Set(pathext.map((extension) => extension.toLowerCase()));
  const command = (name: string) => {
    const extension = win32.extname(name).toLowerCase();
    return extensions.has(extension)
      ? { base: name.slice(0, -extension.length).toLowerCase(), extension }
      : undefined;
  };
  const provided = new Set<string>();
  const plan: WindowsToolPlan = { keep: [], tools: [] };
  const carry = (name: string, target: string) => {
    const found = command(name);
    if (!found || provided.has(found.base) || forbiddenTools.has(found.base)) return;
    provided.add(found.base);
    plan.tools.push({
      name: name.toLowerCase(),
      target,
      kind: found.extension === ".exe" || found.extension === ".com" ? "copy" : "wrapper",
    });
  };
  carry(win32.basename(runtime), runtime);
  for (const { directory, names } of entries) {
    if (versionManagerShim(win32.join(directory, "tool"), "") !== undefined) continue;
    const commands = names.flatMap((name) => {
      const found = command(name);
      return found ? [{ name, base: found.base }] : [];
    });
    if (commands.some(({ base }) => forbiddenTools.has(base))) {
      for (const { name } of commands) carry(name, win32.join(directory, name));
      continue;
    }
    plan.keep.push(directory);
    for (const { base } of commands) provided.add(base);
  }
  return plan;
}

/** Builds the plan's tool folder and returns the PATH value. */
export async function prepareWindowsToolPath(
  directory: string,
  path: string,
  pathext: string,
  runtime: string,
): Promise<string> {
  const entries = await Promise.all(
    path
      .split(";")
      .filter((entry) => win32.isAbsolute(entry))
      .map(async (entry) => ({
        directory: entry,
        names: await readdir(entry).catch(() => []),
      })),
  );
  const plan = planWindowsToolPath(entries, pathext.split(";").filter(Boolean), runtime);
  await mkdir(directory, { recursive: true });
  await Promise.all(
    plan.tools.map(({ name, target, kind }) =>
      kind === "copy"
        ? copyFile(target, win32.join(directory, name))
        : writeFile(win32.join(directory, name), `@call "${target}" %*\r\n`),
    ),
  );
  return [directory, ...plan.keep].join(";");
}
