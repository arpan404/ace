import { digest } from "./crypto.ts";
import type { MachineCredentialStore } from "./credentials.ts";
import type { ActiveSession, SessionReader } from "./session.ts";

/**
 * Who a bearer token is (ADR 0189): an ace session, or a machine credential, which lives on the
 * session it was exchanged from. `hash` is the token's digest.
 */
export type Principal =
  | ({ kind: "session"; hash: string } & ActiveSession)
  | ({ kind: "machine"; hash: string; hostId: string } & ActiveSession);

/**
 * Reads a bearer token as a session or a machine credential. A credential reads its session too,
 * which refreshes it with WorkOS, so a signed-out or deleted account loses its machines as it
 * loses its sessions. A credential whose session is gone, or now names another account, is
 * removed.
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
      const session = await sessions.readHash(credential.session);
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
