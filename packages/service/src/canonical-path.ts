import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

/**
 * One folder's one spelling, for naming its services (ADR 0185): links resolved, and each name
 * spelled as the volume stores it, so `/var/tmp/x` and `/private/var/tmp/x` on macOS, or two
 * cases of a name on a case-insensitive volume, are the same home. A tail that doesn't exist yet
 * is kept as given. I/O: reads the filesystem; never throws.
 */
export function canonicalPath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      existing = realpathSync.native(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
  return join(storedCase(existing), ...rest);
}

const swapCase = (name: string) =>
  Array.from(name, (char) =>
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
  ).join("");

function sameFile(a: string, b: string): boolean {
  try {
    const one = statSync(a);
    const two = statSync(b);
    return one.dev === two.dev && one.ino === two.ino;
  } catch {
    return false;
  }
}

/**
 * `path` (which exists) with each name spelled as its folder lists it. A name whose other case
 * isn't the same file is on a case-sensitive volume and is already exact, so the folder is only
 * listed when the volume folds case.
 */
function storedCase(path: string): string {
  const { root } = parse(path);
  let current = root;
  for (const name of path.slice(root.length).split(sep).filter(Boolean)) {
    let stored = name;
    const other = swapCase(name);
    if (other !== name && sameFile(join(current, name), join(current, other))) {
      try {
        const listed = readdirSync(current);
        if (!listed.includes(name))
          stored =
            listed.find(
              (entry) =>
                entry.toLowerCase() === name.toLowerCase() &&
                sameFile(join(current, entry), join(current, name)),
            ) ?? name;
      } catch {
        // An unlistable folder keeps the name as given.
      }
    }
    current = join(current, stored);
  }
  return current;
}
