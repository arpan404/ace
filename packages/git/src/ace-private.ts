import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Repository } from "./repository.ts";

/**
 * ace's files service keeps uploads in flight and Recently deleted entries under `.ace-upload-*`
 * names inside the checkout. They are ace's, never the person's changes: no add, stash or commit
 * may take them.
 */
export const acePrivatePattern = ".ace-upload-*";

const excludeLine = `${acePrivatePattern}\n`;

/**
 * Name ace's private entries in the repository's local exclude (`info/exclude`, never committed),
 * so status, `git add -A` from any terminal, stashes and checkpoints all skip them. Idempotent.
 */
export async function excludeAcePrivate(repository: Repository, root: string): Promise<void> {
  const located = await repository.cli.call(root, ["rev-parse", "--git-path", "info/exclude"]);
  const relative = located.stdout.toString("utf8").trim();
  if (!relative) return;
  const path = isAbsolute(relative) ? relative : join(root, relative);
  const current = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  if (current.split("\n").includes(acePrivatePattern)) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${separator}# ace: uploads and Recently deleted\n${excludeLine}`);
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
