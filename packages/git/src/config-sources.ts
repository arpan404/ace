import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Where a checkout's Git metadata lives, from `rev-parse --absolute-git-dir --git-common-dir --show-toplevel`. */
export interface CheckoutLayout {
  gitDir: string;
  commonDir: string;
  toplevel: string;
}

export function parseLayout(cwd: string, stdout: string): CheckoutLayout | undefined {
  const [gitDir, commonDir, toplevel, rest] = stdout.split("\n");
  if (!gitDir || !commonDir || !toplevel || rest !== "") return undefined;
  if (!isAbsolute(gitDir) || !isAbsolute(toplevel)) return undefined;
  return { gitDir, commonDir: resolve(cwd, commonDir), toplevel };
}

/**
 * Every file the `config -z --show-origin --show-scope --list` output says Git read, plus the
 * targets of every include directive in them, whether or not those exist yet. Undefined when the
 * listing has an origin or include this module can't place on disk exactly as Git would: then
 * nothing may be cached for the checkout.
 */
export function listedSources(
  listing: Buffer,
  layout: CheckoutLayout,
  home: string | undefined,
): string[] | undefined {
  const text = listing.toString("utf8");
  if (text && !text.endsWith("\0")) return undefined;
  const fields = text ? text.slice(0, -1).split("\0") : [];
  if (fields.length % 3) return undefined;
  const repositoryFiles = new Set([
    join(layout.commonDir, "config"),
    join(layout.gitDir, "config.worktree"),
  ]);
  const files = new Set<string>();
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index];
    const origin = fields[index + 1];
    const entry = fields[index + 2];
    if (scope === undefined || origin === undefined || entry === undefined) return undefined;
    // Our own `-c`/GIT_CONFIG_* pairs: fixed by the caller, never a file.
    if (scope === "command") continue;
    if (!origin.startsWith("file:")) return undefined;
    const named = origin.slice("file:".length);
    // Git names the repository's own files relative to the worktree it changed into.
    const file = isAbsolute(named) ? named : resolve(layout.toplevel, named);
    if (!isAbsolute(named) && !repositoryFiles.has(file)) return undefined;
    files.add(file);
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    if (!/^include(?:if\..*)?\.path$/s.test(key)) continue;
    const target = includeTarget(newline < 0 ? "" : entry.slice(newline + 1), file, home);
    if (target === null) return undefined;
    if (target) files.add(target);
  }
  return [...files];
}

/** Where an include directive points, as Git resolves it; null when that can't be known. */
function includeTarget(value: string, file: string, home: string | undefined): string | null {
  if (!value) return "";
  if (value.startsWith("~/")) return home && isAbsolute(home) ? join(home, value.slice(2)) : null;
  // `~user/` and `%(prefix)/` depend on the account database and Git's build.
  if (value.startsWith("~") || value.startsWith("%(prefix)")) return null;
  return isAbsolute(value) ? value : resolve(dirname(file), value);
}

/**
 * The files whose change can alter what a Git command in `cwd` reads as configuration or which
 * checkout it finds: each listed file and include target, the system and global files even when
 * absent, the checkout's own config files, HEAD (for `includeIf.onbranch`) and, from `cwd` up to
 * its worktree root, every `.git` entry and bare-repository marker (repository discovery).
 */
export function watchedPaths(
  cwd: string,
  layout: CheckoutLayout,
  listed: readonly string[],
  standard: readonly string[],
): string[] | undefined {
  const toTop = relative(layout.toplevel, cwd);
  if (toTop.startsWith("..") || isAbsolute(toTop)) return undefined;
  const discovery: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    discovery.push(join(directory, ".git"));
    if (directory === layout.toplevel) break;
    // Without a `.git` entry, discovery also accepts the directory itself as a bare repository
    // once it holds HEAD, objects/ and refs/, and then reads its `config`.
    for (const part of ["HEAD", "objects", "refs", "config"]) discovery.push(join(directory, part));
    if (dirname(directory) === directory || !directory.startsWith(layout.toplevel + sep))
      return undefined;
  }
  return [
    ...new Set([
      ...discovery,
      join(layout.gitDir, "HEAD"),
      join(layout.gitDir, "commondir"),
      join(layout.gitDir, "gitdir"),
      join(layout.gitDir, "config.worktree"),
      join(layout.commonDir, "config"),
      ...standard,
      ...listed,
    ]),
  ];
}
