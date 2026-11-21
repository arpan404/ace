import { digest } from "./crypto.ts";
import { orgPrincipal, type MachineCredentialStore } from "./credentials.ts";
import type { ActiveSession, SessionReader } from "./session.ts";

/**
 * Who a bearer token is (ADR 0190): an ace session, or a machine credential, which lives on the
 * session it was exchanged from. An org host's organization credential (ADR 0206 §2.1) is a
 * machine credential too, with `org` set: it lives on no session, and its account is the
 * organization's own principal, never a person. `hash` is the token's digest.
 */
export type Principal =
  | ({ kind: "session"; hash: string } & ActiveSession)
  | ({ kind: "machine"; hash: string; hostId: string; org?: string } & ActiveSession);

/**
 * The account an organization credential reads as: the organization's principal. The address
 * is a placeholder in a reserved domain (it must parse as one); it reaches nobody.
 */
const orgAccount = (org: string, name: string) => ({
  id: orgPrincipal(org),
  email: `host@${org.toLowerCase()}.invalid`,
  name,
});

/**
 * Reads a bearer token as a session or a machine credential. A credential reads its session too,
 * which refreshes it with WorkOS, so a signed-out or deleted account loses its machines as it
 * loses its sessions. A credential whose session is gone, or now names another account, is
 * removed. An organization credential reads only while its organization holds the host under the
 * enrollment it was issued for.
 */
export function principalReader(deps: {
  sessions: SessionReader;
  credentials: MachineCredentialStore;
  now: () => number;
}) {
  const { sessions, credentials, now } = deps;
  return {
    async read(token: string): Promise<Principal | undefined> {
      const hash = await digest(token);
      const credential = await credentials.get(hash, now());
      if (!credential) {
        const session = await sessions.readHash(hash);
        return session ? { kind: "session", hash, ...session } : undefined;
      }
      if (credential.kind === "org") {
        // Released, or enrolled again since: it speaks for nobody and goes.
        if (!credential.held) {
          await credentials.remove(hash);
          return undefined;
        }
        // No session behind it, so nothing to refresh: only the host key renews it.
        return {
          kind: "machine",
          hash,
          hostId: credential.hostId,
          org: credential.org,
          account: orgAccount(credential.org, credential.orgName),
          expiresAt: credential.expiresAt,
          signedInAt: 0,
          standing: "exposed",
        };
      }
      const session = await sessions.readHash(credential.session, true);
      if (!session || session.account.id !== credential.accountId) {
        await credentials.remove(hash);
        return undefined;
      }
      await credentials.renew(hash, session.expiresAt);
      return {
        kind: "machine",
        hash,
        hostId: credential.hostId,
        ...session,
        // What its session was, a machine credential never is: the person.
        standing: "exposed",
      };
    },
    /** Signs a token out: a session, or a credential (with its session when it was the only holder). */
    async revoke(token: string) {
      const hash = await digest(token);
      if (await credentials.get(hash, now())) await credentials.remove(hash);
      else await sessions.revoke(token);
    },
  };
}
export type PrincipalReader = ReturnType<typeof principalReader>;
