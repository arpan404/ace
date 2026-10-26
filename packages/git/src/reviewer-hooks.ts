import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

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
  return paths.some(
    (path) => roots.some((each) => under(path, each)) && !owned.some((each) => under(path, each)),
  );
}
