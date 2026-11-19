import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  folderHash,
  nextBuiltinsLock,
  readBuiltinsLock,
  type BuiltinsLock,
} from "../src/builtin-lock.ts";

/**
 * Rewrites `packages/plugins/builtins-lock.json` from the shipped skills and Suits: a built-in
 * whose files changed goes up a version and keeps its old hash, so installed copies of it are
 * still recognised as ace's and updated. With `--check`, fails instead when the lock is stale.
 */
const plugins = join(import.meta.dirname, "..");
const lockPath = join(plugins, "builtins-lock.json");
const check = process.argv.includes("--check");

async function folders(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory()) hashes[entry.name] = await folderHash(join(root, entry.name));
  return hashes;
}

const current: BuiltinsLock | undefined = await readBuiltinsLock(lockPath).catch(() => undefined);
const next = nextBuiltinsLock(current, {
  skills: await folders(join(plugins, "builtin-skills", "skills")),
  suits: await folders(join(plugins, "builtin-suits")),
});
// Compared as data: the formatter owns the file's layout.
const before = await readFile(lockPath, "utf8").catch(() => "null");
if (JSON.stringify(next) === JSON.stringify(JSON.parse(before)))
  process.stdout.write("builtins-lock.json is current.\n");
else if (check) {
  const changed = (["skills", "suits"] as const).flatMap((kind) =>
    Object.keys({ ...current?.[kind], ...next[kind] })
      .filter((name) => current?.[kind][name]?.hash !== next[kind][name]?.hash)
      .map((name) => `${kind}/${name}`),
  );
  process.stderr.write(
    `builtins-lock.json is stale (${changed.join(", ") || "format"}); run bun run builtins:lock\n`,
  );
  process.exit(1);
} else {
  await writeFile(lockPath, JSON.stringify(next, null, 2) + "\n");
  execFileSync("bun", ["x", "oxfmt", lockPath], { stdio: "inherit" });
  process.stdout.write("Wrote builtins-lock.json.\n");
}
