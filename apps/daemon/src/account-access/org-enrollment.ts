import { encodeBase64url } from "@ace/account-grant";
import { ORG_ENROLL_LIFETIME_MS, orgEnrollProof } from "@ace/account-grant/machine-proof";
import type { AceOrgEnrollConsent } from "@ace/protocol/ace-org";
import type { KeyPair } from "@ace/secure-channel";
import type { accountBackend } from "./backend.ts";
import type { MachineOwner } from "./owner.ts";

/*
 * Giving this machine to an organization (ADR 0206 §2.1), the machine's side. The backend enrolls
 * a host only with the machine's own consent, which the daemon gives only to a socket that proved
 * its owner's standing (ADR 0190): for one organization, naming that owner, once (the backend
 * spends its nonce), for five minutes. Once the backend says it holds this machine as the
 * organization's host, the daemon answers to the organization, and every person's standing ends.
 */

export type EnrollRefusal = "not_owner" | "signed_out" | "unavailable";

export function orgEnrollment(deps: {
  owner: MachineOwner;
  backend: ReturnType<typeof accountBackend>;
  /** The machine's live session: where it signs in, and the credential it holds. */
  session: () => { origin: string; token: string } | undefined;
  relayKeys: () => Promise<KeyPair>;
  hostId: () => Promise<string>;
  randomBytes: (size: number) => Buffer;
  now: () => number;
  signal: () => AbortSignal;
}) {
  /** The consent last given, until it is used or lapses: one at a time. */
  let given: { org: string; account: string; generation: number; expiresAt: number } | undefined;
  return {
    /**
     * The machine's consent to become `org`'s host, for `account`, the owner a socket proved under
     * `generation`. Refused unless that is still the owner and nothing changed since.
     */
    async consent(input: {
      org: string;
      account: string;
      generation: number;
    }): Promise<{ ok: true; consent: AceOrgEnrollConsent } | { ok: false; code: EnrollRefusal }> {
      if (!deps.owner.holds(input.generation) || deps.owner.current() !== input.account)
        return { ok: false, code: "not_owner" };
      const current = deps.session();
      if (!current) return { ok: false, code: "signed_out" };
      let exchangeKey;
      try {
        exchangeKey = (await deps.backend.keys(current.origin, deps.signal())).exchangeKey;
      } catch {
        return { ok: false, code: "unavailable" };
      }
      if (exchangeKey === undefined) return { ok: false, code: "unavailable" };
      // Checked again after the network: the owner may have changed while the keys came back.
      if (!deps.owner.holds(input.generation) || deps.owner.current() !== input.account)
        return { ok: false, code: "not_owner" };
      const keys = await deps.relayKeys();
      const terms = {
        hostId: await deps.hostId(),
        org: input.org,
        account: input.account,
        nonce: deps.randomBytes(16).toString("base64url"),
        expiresAt: deps.now() + ORG_ENROLL_LIFETIME_MS,
      };
      given = {
        org: input.org,
        account: input.account,
        generation: input.generation,
        expiresAt: terms.expiresAt,
      };
      return {
        ok: true,
        consent: {
          ...terms,
          hostKey: encodeBase64url(keys.publicKey),
          proof: orgEnrollProof({
            hostPrivateKey: keys.privateKey,
            exchangeKey,
            consent: terms,
          }),
        },
      };
    },
    /**
     * The client enrolled this machine with the consent it was given: true once the backend holds
     * it as `org`'s host and the machine answers to `org`. Only for the consent last given, to the
     * same owner, with nothing changed since; `drop` ends what is kept beyond a socket.
     */
    async confirm(input: { org: string; drop: () => void }): Promise<boolean> {
      const pending = given;
      if (!pending || pending.org !== input.org) return false;
      // Enrolled, the consent was spent within its five minutes; confirming later is refused.
      if (deps.now() > pending.expiresAt + ORG_ENROLL_LIFETIME_MS) return false;
      if (!deps.owner.holds(pending.generation)) return false;
      const current = deps.session();
      if (!current) return false;
      const held = await deps.backend
        .isOrgHost(current.origin, current.token, input.org, deps.signal())
        .catch(() => false);
      if (!held) return false;
      const done = await deps.owner.enroll(
        pending.account,
        input.org,
        pending.generation,
        input.drop,
      );
      if (done && given === pending) given = undefined;
      return done;
    },
  };
}
export type OrgEnrollment = ReturnType<typeof orgEnrollment>;
