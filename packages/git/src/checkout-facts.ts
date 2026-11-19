import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { normalizeRemoteUrl } from "./remote-url.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

/** What a folder is a checkout of, for suggesting the same project on another machine. */
export interface CheckoutFacts {
  /** Every remote's fetch URLs as `normalizeRemoteUrl` keys, sorted, without repeats. */
  remotes: string[];
  /** The folder inside its work tree, `/`-separated; "" at the work tree's top. */
  subpath: string;
}

/** The most remote keys one checkout reports. */
const remoteLimit = 64;

/** `path`'s checkout facts; undefined for a folder outside any Git work tree. */
export async function checkoutFacts(
  repository: Repository,
  path: string,
): Promise<CheckoutFacts | undefined> {
  let root: string;
  try {
    root = await repository.root(path);
  } catch (error) {
    if (error instanceof GitError && error.code === "not_a_repo") return undefined;
    throw error;
  }
  const remotes = await repository.remotes(root);
  const keys = new Set(
    remotes.flatMap((remote) => remote.fetchUrls.map((url) => normalizeRemoteUrl(url, root))),
  );
  return {
    remotes: [...keys].toSorted().slice(0, remoteLimit),
    subpath: subpathOf(root, await realpath(path).catch(() => path)),
  };
}

/**
 * `path`'s folder inside the work tree at `root`, `/`-separated; "" at its top or outside it.
 * Only a `..` segment leads out: a folder named `..tools` is inside.
 */
export function subpathOf(root: string, path: string): string {
  const inside = relative(root, path);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return "";
  return inside.split(sep).join("/");
}
