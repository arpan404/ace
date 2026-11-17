/**
 * Storage bounds for an environment ace keeps (an account's catalog row, an ACP login plan):
 * cheap per-string maxima a schema checks first. They don't decide whether the environment can
 * be launched; `environmentLaunchError` does.
 */
export const ENV_NAME_LIMIT = 4096;
export const ENV_VALUE_LIMIT = 131_072;

/**
 * What one exec accepts, in the OS's own unit: `string` bounds one `NAME=value` with its
 * terminator, `block` the whole environment with its pointers. The block is the environment's
 * share of the exec limit: `ARGV_RESERVE` is left for the arguments, which share it.
 */
export type LaunchLimits = { unit: "utf8" | "utf16"; string: number; block: number };

/** Left of ARG_MAX for a launch's own arguments and their pointers. */
export const ARGV_RESERVE = 131_072;
const POINTER = 8;

/**
 * Linux: MAX_ARG_STRLEN (32 pages, 131072 bytes, terminator included) per string, and ARG_MAX
 * (a quarter of the default 8 MiB stack: 2 MiB) for strings and pointers together.
 * macOS: ARG_MAX (1 MiB) for everything, with no separate per-string limit.
 * Windows: 32767 UTF-16 units per variable, terminator included. Its block has no OS limit, so
 * it gets Linux's 2 MiB as a bound.
 */
export function launchLimits(platform: NodeJS.Platform): LaunchLimits {
  if (platform === "linux")
    return { unit: "utf8", string: 131_072, block: 2_097_152 - ARGV_RESERVE };
  if (platform === "win32") return { unit: "utf16", string: 32_767, block: 2_097_152 };
  // macOS and the BSDs share one ARG_MAX accounting.
  const block = 1_048_576 - ARGV_RESERVE;
  return { unit: "utf8", string: block - 2 * POINTER, block };
}

/**
 * Why `env` can't be launched on `platform`, or undefined when it can. Counts what an exec
 * counts: each set variable's `NAME=value` and terminator in the OS's encoding, and on POSIX a
 * pointer for each plus one ending the list. A masked (undefined) variable isn't launched.
 */
export function environmentLaunchError(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const limits = launchLimits(platform);
  const utf8 = limits.unit === "utf8";
  const unit = utf8 ? "bytes" : "UTF-16 units";
  let block = utf8 ? POINTER : 0;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const entry = `${name}=${value}`;
    const size = (utf8 ? Buffer.byteLength(entry, "utf8") : entry.length) + 1;
    if (size > limits.string)
      return `Variable ${name} is ${size} ${unit} with its terminator, over the ${limits.string} a process can start with`;
    block += size + (utf8 ? POINTER : 0);
  }
  if (block > limits.block)
    return `The environment is ${block} ${unit}, over the ${limits.block} a process can start with`;
  return undefined;
}
