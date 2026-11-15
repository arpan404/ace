import { z } from "zod";

/**
 * Which checkout a web build was made from. The daemon serves `apps/web/dist` from a fixed path,
 * so a build left there by another branch or before a source edit would be measured as this
 * checkout's; the slow-link run writes this stamp beside each build it makes and rebuilds
 * whenever `reuseBuild` says no.
 */
export const BuildStamp = z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/) });
export type BuildStamp = z.infer<typeof BuildStamp>;

/** The checkout now: its commit, and whether any tracked file differs from it. */
export interface Checkout {
  commit: string;
  dirty: boolean;
}

/**
 * Why a build cannot stand for this checkout, or undefined when it can: it must carry our stamp,
 * from this commit, with no tracked file edited since (an edit may be anything the build reads).
 */
export function staleBuild(stamp: unknown, checkout: Checkout): string | undefined {
  const parsed = BuildStamp.safeParse(stamp);
  if (!parsed.success) return "it was not built by this run (no build stamp)";
  if (parsed.data.commit !== checkout.commit)
    return `it was built from ${parsed.data.commit.slice(0, 10)}, not ${checkout.commit.slice(0, 10)}`;
  if (checkout.dirty) return "tracked files have changed since the last commit";
  return undefined;
}
