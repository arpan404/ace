import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Repository } from "./repository.ts";

/**
 * ace's files service keeps uploads in flight and Recently deleted entries under `.ace-upload-*`
 * names inside the checkout. They are ace's, never the person's changes: no add, stash or commit
 * may take them.
 */
export const acePrivatePattern = ".ace-upload-*";

const excludeLine = `${acePrivatePattern}\n`;

/** Whether a repository path is, or lies inside, one of ace's private entries. */
export function isAcePrivate(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".ace-upload-"));
}

/**
 * Name ace's private entries in the repository's local exclude (`info/exclude`, never committed),
 * so status, `git add -A` from any terminal, stashes and checkpoints all skip them. Idempotent.
 */
export async function excludeAcePrivate(repository: Repository, root: string): Promise<void> {
  const located = await repository.cli.call(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--git-path",
    "info/exclude",
  ]);
  const [commonDir, excludePath] = located.stdout.toString("utf8").trim().split("\n");
  if (!commonDir || !excludePath) return;
  const path = isAbsolute(excludePath) ? excludePath : join(root, excludePath);
  // Only a plain file in a plain folder inside the repository's own git dir: never through a
  // symlink to somewhere else. Otherwise skip; every add ace runs excludes these entries itself.
  if (!(await plainInside(await realpath(commonDir), dirname(path), path))) return;
  const current = await readFile(path, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return "";
    throw error;
  });
  if (current.split("\n").includes(acePrivatePattern)) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${separator}# ace: uploads and Recently deleted\n${excludeLine}`);
}

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** `folder` and `file` are no symlinks (or absent), and `folder` resolves inside `gitDir`. */
async function plainInside(gitDir: string, folder: string, file: string): Promise<boolean> {
  for (const [path, kind] of [
    [folder, "directory"],
    [file, "file"],
  ] as const) {
    const stat = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink()) return false;
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return false;
  }
  const parent = await realpath(dirname(folder)).catch(() => undefined);
  if (!parent) return false;
  const inside = relative(gitDir, join(parent, basename(folder)));
  return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/**
 * Pathspecs for an `add` of the person's paths: each literal (a file named `*.ts` is that file),
 * then excludes for ace's private entries wherever they sit. Run without `GIT_LITERAL_PATHSPECS`.
 */
export function personPathspecs(paths: readonly string[]): string[] {
  return [
    ...paths.map((path) => `:(literal)${path}`),
    `:(exclude,glob)**/${acePrivatePattern}`,
    `:(exclude,glob)**/${acePrivatePattern}/**`,
  ];
}
