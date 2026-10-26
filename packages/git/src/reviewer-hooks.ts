import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { win32 } from "node:path";

interface Output {
  stdout: Buffer;
  exitCode: number;
}
type Query = (args: string[]) => Promise<Output>;

const text = (output: Output) => output.stdout.toString("utf8").replace(/\n$/, "");

/** `path` is `root` or lies under it. */
const under = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * The paths a configured hook command names: every word holding a `/`, quotes removed, read
 * against the working tree root (where Git runs hooks). A bare program name on PATH names none.
 */
export function hookCommandPaths(command: string, top: string): string[] {
  return command
    .split(/\s+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ""))
    .filter((word) => word.includes("/"))
    .map((word) => resolvePath(top, word));
}

/**
 * Whether a hook Git would run in the checkout at `cwd` lives inside it: the hooks directory
 * (a relative `core.hooksPath` such as `.husky`), or a configured `hook.<name>.command` naming a
 * file in the working tree. Inside a pull request's checkout either is its author's program.
 */
export async function hooksInsideCheckout(query: Query, cwd: string): Promise<boolean> {
  const [hooks, top, common, commands] = await Promise.all([
    query(["rev-parse", "--git-path", "hooks"]),
    query(["rev-parse", "--path-format=absolute", "--show-toplevel"]),
    query(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    query(["config", "--null", "--get-regexp", "^hook\\..*\\.command$"]),
  ]);
  const root = text(top) || cwd;
  const roots = [root, await realpath(root).catch(() => root)];
  // The repository's own Git directory (its `hooks`) is not the checkout's content, even in a
  // main checkout where it sits inside the working tree.
  const own = text(common);
  const owned = own ? [own, await realpath(own).catch(() => own)] : [];
  const lexical = resolvePath(cwd, text(hooks));
  const named =
    commands.exitCode === 0
      ? commands.stdout
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .flatMap((entry) => hookCommandPaths(entry.slice(entry.indexOf("\n") + 1), root))
      : [];
  const candidates = [lexical, ...named];
  const resolved = await Promise.all(candidates.map((path) => realpath(path).catch(() => path)));
  const paths = [...candidates, ...resolved];
  if (process.platform === "win32")
    return windowsInside(
      paths,
      commands.exitCode === 0 ? commands.stdout : undefined,
      roots,
      owned,
    );
  return paths.some(
    (path) => roots.some((each) => under(path, each)) && !owned.some((each) => under(path, each)),
  );
}

const windowsKey = (path: string) => win32.resolve(path).toLowerCase();
/** Windows: `path` is `parent` or lies under it, without regard to separators or case. */
function windowsUnder(path: string, parent: string): boolean {
  const relative = win32.relative(windowsKey(parent), windowsKey(path));
  return (
    relative === "" ||
    (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"))
  );
}

/**
 * Windows: Git prints `C:/...` while Node resolves `C:\\...`, names compare without case, and a
 * hook command may name its file with backslashes (`scripts\\check.cmd`).
 */
async function windowsInside(
  paths: string[],
  commands: Buffer | undefined,
  roots: string[],
  owned: string[],
): Promise<boolean> {
  const root = roots[0] ?? "";
  const backslashed = (commands?.toString("utf8").split("\0").filter(Boolean) ?? []).flatMap(
    (entry) =>
      entry
        .slice(entry.indexOf("\n") + 1)
        .split(/\s+/)
        .map((word) => word.replace(/^['"]|['"]$/g, ""))
        .filter((word) => word.includes("\\"))
        .map((word) => win32.resolve(root, word)),
  );
  const extra = await Promise.all(backslashed.map((path) => realpath(path).catch(() => path)));
  return [...paths, ...backslashed, ...extra].some(
    (path) =>
      roots.some((each) => windowsUnder(path, each)) &&
      !owned.some((each) => windowsUnder(path, each)),
  );
}
