/**
 * An account's environment as a model catalog row. A masked variable (undefined) goes to
 * `unsetEnv`, never to an empty value: Cursor's SDK takes an empty `CURSOR_API_KEY` over the
 * account's saved login, so `""` would read as signed out.
 */
export function catalogEnvironment(env: NodeJS.ProcessEnv): {
  env: Record<string, string>;
  unsetEnv: string[];
} {
  const set: Record<string, string> = {};
  const unsetEnv: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) unsetEnv.push(key);
    else set[key] = value;
  }
  return { env: set, unsetEnv };
}
