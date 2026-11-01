const argv = process.argv.slice(2);

/** `--name=value` from the command line. */
export function option(name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** A non-negative integer option with a default. */
export function count(name: string, fallback: number): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a count`);
  return parsed;
}
