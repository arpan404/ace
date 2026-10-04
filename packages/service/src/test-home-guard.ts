import { isAbsolute, relative, resolve } from "node:path";

/** Test-only boundary check. No path work or filesystem access in production. */
export function assertTestHomeIsolation(
  path: string,
  realHome = process.env.ACE_TEST_REAL_HOME,
): void {
  if (!realHome) return;
  const destination = resolve(path);
  const difference = relative(resolve(realHome), destination);
  if (difference === "" || (!isAbsolute(difference) && difference.split(/[\\/]/)[0] !== ".."))
    throw new Error(
      `ACE_TEST_REAL_HOME guard refused ${destination}: tests must use an isolated HOME and ACE_HOME outside the real user home ${realHome}`,
    );
}
