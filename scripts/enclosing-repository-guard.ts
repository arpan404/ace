import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { basename, dirname, join } from "node:path";

/** Settings that turn a checkout (and every linked worktree) into a "bare" repository. */
const restorable = new Set(["core.bare", "core.worktree"]);

/**
 * The repository a test run is started from: its config files with their `[core]` settings at
 * startup, and the checkout roots a test git must never discover. Plain data, so Vitest can hand
 * it from global setup to every worker.
 */
export interface EnclosingRepository {
  configs: Record<string, Record<string, string>>;
  checkouts: string[];
}

export interface CoreChange {
  file: string;
  key: string;
  before: string | undefined;
  after: string | undefined;
}

/** `[core]` settings of one git config file. Repeated keys keep every value, in order. */
export function coreSettings(text: string): Record<string, string> {
  const settings: Record<string, string> = {};
  let core = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    const header = /^\[\s*([^\]\s"]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]/.exec(line);
    if (header) {
      core = header[1]?.toLowerCase() === "core";
      line = line.slice(header[0].length).trim();
    }
    if (!core || !line || line.startsWith("#") || line.startsWith(";")) continue;
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!entry?.[1]) continue;
    const key = `core.${entry[1].toLowerCase()}`;
    const value = entry[2] === undefined ? "true" : entry[2].trim();
    settings[key] = key in settings ? `${settings[key]}\n${value}` : value;
  }
  return settings;
}

/** Every `[core]` setting whose value differs between two snapshots of the same files. */
export function coreChanges(
  before: EnclosingRepository["configs"],
  after: EnclosingRepository["configs"],
): CoreChange[] {
  const changes: CoreChange[] = [];
  for (const file of Object.keys(before)) {
    const was = before[file] ?? {};
    const now = after[file] ?? {};
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)]))
      if (was[key] !== now[key]) changes.push({ file, key, before: was[key], after: now[key] });
  }
  return changes;
}

function readConfigs(files: readonly string[]): EnclosingRepository["configs"] {
  return Object.fromEntries(
    files.map((file) => [file, existsSync(file) ? coreSettings(readFileSync(file, "utf8")) : {}]),
  );
}

/** Git for the guard itself: no inherited selectors, no user or system config. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

/** Snapshot the repository containing `root`, or undefined when the tests run outside one. */
export function captureEnclosingRepository(root: string): EnclosingRepository | undefined {
  let output: string;
  try {
    output = git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], root);
  } catch {
    return undefined;
  }
  const [common, gitDir] = output.split("\n");
  if (!common || !gitDir) return undefined;
  const checkouts = new Set<string>();
  try {
    checkouts.add(git(["rev-parse", "--show-toplevel"], root));
  } catch {
    // An already bare-flagged checkout has no top level; its config is still guarded.
  }
  if (basename(common) === ".git") checkouts.add(dirname(common));
  const files = [
    ...new Set([
      join(common, "config"),
      join(common, "config.worktree"),
      join(gitDir, "config.worktree"),
    ]),
  ];
  return { configs: readConfigs(files), checkouts: [...checkouts] };
}

/**
 * Fail loudly when a test changed the enclosing repository's `[core]` settings. A flipped
 * `core.bare` or `core.worktree` breaks the checkout and every linked worktree, so those are put
 * back before the error is thrown; anything else is only reported.
 */
export function verifyEnclosingRepository(
  repository: EnclosingRepository | undefined,
  culprit: string,
): void {
  if (!repository) return;
  const changes = coreChanges(repository.configs, readConfigs(Object.keys(repository.configs)));
  if (!changes.length) return;
  const restored: string[] = [];
  for (const change of changes) {
    if (!restorable.has(change.key) || !existsSync(change.file)) continue;
    const previous = change.before?.split("\n").at(-1);
    const args =
      previous === undefined
        ? ["config", "--file", change.file, "--unset-all", change.key]
        : ["config", "--file", change.file, "--replace-all", change.key, previous];
    try {
      git(args, dirname(change.file));
      restored.push(change.key);
    } catch {
      // The report below still names the change; the person can repair it by hand.
    }
  }
  const lines = changes.map(
    (change) =>
      `  ${change.file}: ${change.key} ${change.before ?? "<unset>"} -> ${change.after ?? "<unset>"}`,
  );
  throw new Error(
    [
      `${culprit} changed the git config of the repository running the tests:`,
      ...lines,
      "A test or helper ran git against the real checkout (a cwd that fell back to it, or an inherited GIT_DIR).",
      restored.length ? `Restored ${restored.join(", ")}.` : "Nothing was restored.",
    ].join("\n"),
  );
}
