/**
 * Whether Spade is left out: built with `DISABLE_SPADE=1` (the release bundle bakes it in) or
 * started with `DISABLE_SPADE=1` in the environment. Then nothing registers its service or makes
 * its grant, whatever `spade.enabled` says.
 */
export function spadeDisabled(env: Record<string, string | undefined>): boolean {
  return process.env.ACE_BUILD_DISABLE_SPADE === "1" || env.DISABLE_SPADE === "1";
}
