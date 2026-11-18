/**
 * Lints ace cloud's and the market's D1 migrations (docs/release/workers.md). Exits 1 with each
 * problem when any migration would break a Worker version still running during a release.
 *
 *   node tools/workers-release/src/check-migrations.ts [directory…]
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { formatProblem, lintMigrations, type MigrationProblem } from "./migration-lint.ts";

export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Where each Worker keeps its migrations. */
export const migrationRoots = {
  cloud: join(repositoryRoot, "apps/cloud/migrations"),
  market: join(repositoryRoot, "apps/market/migrations"),
} as const;

async function sqlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sqlFiles(path);
      return entry.name.endsWith(".sql") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

/** Every problem under these directories, with paths relative to the repository. */
export async function checkMigrations(directories: readonly string[]): Promise<MigrationProblem[]> {
  const paths = (await Promise.all(directories.map(sqlFiles))).flat();
  const files = await Promise.all(
    paths.map(async (path) => ({
      file: relative(repositoryRoot, path),
      sql: await readFile(path, "utf8"),
    })),
  );
  return lintMigrations(files);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const given = process.argv.slice(2);
  const directories = given.length > 0 ? given : Object.values(migrationRoots);
  const problems = await checkMigrations(directories);
  for (const problem of problems) console.error(formatProblem(problem));
  if (problems.length > 0) {
    console.error(`\n${problems.length} migration problem(s); see docs/release/workers.md.`);
    process.exitCode = 1;
  } else {
    console.log("Migrations only expand.");
  }
}
