import type path from "node:path";

export interface TestHomeGuardPorts {
  cwd: string;
  paths: Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "dirname" | "basename" | "join">;
  realpath(path: string): string;
}

function inside(root: string, candidate: string, paths: TestHomeGuardPorts["paths"]): boolean {
  const difference = paths.relative(root, candidate);
  return (
    difference === "" || (!paths.isAbsolute(difference) && difference.split(/[\\/]/)[0] !== "..")
  );
}

/** Resolve existing ancestors without losing the absent suffix of a future destination. */
function canonical(candidate: string, ports: TestHomeGuardPorts): string {
  let ancestor = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      return ports.paths.join(ports.realpath(ancestor), ...suffix.toReversed());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = ports.paths.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(ports.paths.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Pure policy with injected path semantics, filesystem resolution and working directory. */
export function createTestHomeGuard(realHome: string, ports: TestHomeGuardPorts) {
  const protectedRoot = ports.paths.resolve(ports.cwd, realHome);
  return (path: string): void => {
    const candidate = ports.paths.resolve(ports.cwd, path);
    const refuse = () => {
      throw new Error(
        `ACE_TEST_REAL_HOME guard refused ${candidate}: tests must use an isolated HOME and ACE_HOME outside the real user home ${protectedRoot}`,
      );
    };
    // Direct descendants are refused without inspecting anything in the protected root.
    if (inside(protectedRoot, candidate, ports.paths)) refuse();
    if (inside(canonical(protectedRoot, ports), canonical(candidate, ports), ports.paths)) refuse();
  };
}
