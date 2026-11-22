import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/*
 * Whether the daemon beside the app answers to an organization (ADR 0206 §2.1): its
 * `ace-owner.json` says `{kind: "org"}`. Read from the file the daemon writes, so the desktop
 * app's main process knows it without a socket; read again whenever that file changes.
 */

const OrgOwner = z.object({ kind: z.literal("org") });

export function ownerMode(home: string | undefined, now: () => number) {
  /** Kept at most this long when no change was heard, in case a watch event was lost. */
  const staleMs = 2_000;
  let read: { org: boolean; at: number } | undefined;
  const readNow = (): boolean => {
    if (home === undefined) return false;
    try {
      return OrgOwner.safeParse(JSON.parse(readFileSync(join(home, "ace-owner.json"), "utf8")))
        .success;
    } catch {
      return false;
    }
  };
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
