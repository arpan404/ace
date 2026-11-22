import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/*
 * Whether the daemon beside the app answers to an organization (ADR 0206 §2.1): its
 * `ace-owner.json` says `{kind: "org"}`. Read from the file the daemon writes, so the desktop
 * app's main process knows it without a socket; read again whenever either file changes. The seal
 * (`ace-org-seal.json`, ADR 0209 amendment 1) keeps a released or enrolling org host's home an
 * organization's.
 */

const OrgOwner = z.object({ kind: z.literal("org") });

export function ownerMode(home: string | undefined) {
  const holds = (file: string, schema: z.ZodType): boolean => {
    if (home === undefined) return false;
    try {
      return schema.safeParse(JSON.parse(readFileSync(join(home, file), "utf8"))).success;
    } catch {
      return false;
    }
  };
  /**
   * Whether a seal is there. Only a missing one (`ENOENT`) isn't: a seal that can't be read or
   * doesn't parse fails closed and counts, as the daemon reads it.
   */
  const sealed = (): boolean => {
    if (home === undefined) return false;
    try {
      readFileSync(join(home, "ace-org-seal.json"), "utf8");
      return true;
    } catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ENOENT");
    }
  };
  // The seal first: it outlives a release and the local reset, and any owner record beside it.
  const readNow = (): boolean => sealed() || holds("ace-owner.json", OrgOwner);
  return {
    /**
     * Whether the daemon's home is an organization's host now: read afresh on every ask, since
     * each send and each reply asks (ADR 0209 §3). Two small files; nothing is cached.
     */
    orgHost(): boolean {
      return readNow();
    },
    /** A file changed: nothing is cached, so the next ask reads it anyway. */
    changed(): void {},
  };
}
