/** The PATH one daemon spawn gets. */
export interface SpawnPath {
  path: string;
  /**
   * Set when `path` is the one saved last session because the login shell had not answered
   * yet: the shell's PATH, which the daemon must get before it reads provider CLIs.
   */
  confirm?: Promise<string>;
}

export interface LaunchPaths {
  /** The PATH for the next spawn, waiting for the login shell only when nothing is saved. */
  next(): Promise<SpawnPath>;
}

/**
 * Which PATH the daemon is spawned on. The login shell can take seconds (`login-path.ts`), so
 * a launch with a PATH saved from the last one spawns at once on it and hands the shell's PATH
 * to the daemon once it answers; the first launch waits for the shell. Once the shell has
 * answered, every spawn uses its PATH, and a PATH that differs from the saved one is saved.
 */
export function launchPaths(input: {
  saved: string | undefined;
  login: Promise<string>;
  save: (path: string) => void;
}): LaunchPaths {
  let fresh: string | undefined;
  const login = input.login.then((path) => {
    fresh = path;
    if (path !== input.saved) input.save(path);
    return path;
  });
  const saved = input.saved || undefined;
  return {
    async next() {
      if (fresh !== undefined) return { path: fresh };
      if (saved !== undefined) return { path: saved, confirm: login };
      return { path: await login };
    },
  };
}
