import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/*
 * Whether the daemon beside the app answers to an organization (ADR 0206 §2.1): its
 * `ace-owner.json` says `{kind: "org"}`. Read from the file the daemon writes, so the desktop
 * app's main process knows it without a socket; read again whenever either file changes. The seal
 * (`ace-org-seal.json`) keeps a released org host's home an organization's.
 */

const OrgOwner = z.object({ kind: z.literal("org") });
/** A released or enrolling org host's seal (ADR 0209 amendment 1): it stays an org's home. */
const OrgSeal = z.object({ kind: z.literal("org-seal") });

export function ownerMode(home: string | undefined, now: () => number) {
  /** Kept at most this long when no change was heard, in case a watch event was lost. */
  const staleMs = 1_000;
  let read: { org: boolean; at: number } | undefined;
  const holds = (file: string, schema: z.ZodType): boolean => {
    if (home === undefined) return false;
    try {
      return schema.safeParse(JSON.parse(readFileSync(join(home, file), "utf8"))).success;
    } catch {
      return false;
    }
  };
  // The seal first: it outlives a release and the local reset, and any owner record beside it.
  const readNow = (): boolean =>
    holds("ace-org-seal.json", OrgSeal) || holds("ace-owner.json", OrgOwner);
  return {
    /** Whether the daemon's home is an organization's host now. */
    orgHost(): boolean {
      if (!read || now() - read.at > staleMs) read = { org: readNow(), at: now() };
      return read.org;
    },
    /** The file changed: read it on the next ask. */
    changed(): void {
      read = undefined;
    },
  };
}
