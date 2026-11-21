import { GrantKeySet, encodeBase64url } from "@ace/account-grant";
import {
  ORG_ENROLL_LIFETIME_MS,
  machineCredentialProof,
  orgEnrollProof,
  orgHostCredentialProof,
} from "@ace/account-grant/machine-proof";
import { hostId, keyPair } from "@ace/secure-channel";
import type { WorkosUser } from "./fake-workos.ts";

/** A WorkOS user with a verified email, as most org tests need. */
export const workosUser = (id: string, first: string, verified = true): WorkosUser => ({
  id,
  email: `${first.toLowerCase()}@example.com`,
  first_name: first,
  last_name: null,
  email_verified: verified,
});

/** An uncompressed P-256 point's length in base64url: what a device key looks like. */
export const DEVICE_KEY = encodeBase64url(new Uint8Array(65).fill(4));

/** What `machine` writes to: the Worker's D1, typed here so other workspaces need no Workers types. */
type Directory = {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
};

/** Calls to the Worker's account API as a client would, returning the status and JSON body. */
export function orgCalls(http: string) {
  async function call(
    token: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${http}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const parsed: unknown = await response.json().catch(() => ({}));
    return {
      status: response.status,
      body:
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
    };
  }
  // The Worker's keys don't change while it runs: read once, so tests stay inside its rate limit.
  let published: Promise<GrantKeySet> | undefined;
  const keys = () =>
    (published ??= fetch(`${http}/v1/keys`)
      .then((response) => response.json())
      .then((body) => GrantKeySet.parse(body)));
  return {
    call,
    keys,
    /** A new organization owned by the session's account; its id. */
    async createOrg(token: string, name: string): Promise<string> {
      const created = await call(token, "POST", "/v1/orgs", { name });
      if (created.status !== 201) throw new Error(`Creating an org failed: ${created.status}`);
      return String(created.body.id);
    },
    /** A member grant for `host`, or the refusal. */
    memberGrant: (token: string, org: string, host: string) =>
      call(token, "POST", "/v1/grants", {
        kind: "member",
        org,
        host,
        subject: "phone",
        key: DEVICE_KEY,
      }),
    /**
     * A machine signed in to the account (its directory row, as the relay writes it) with a
     * machine credential its daemon would keep; `session` is the session it exchanges.
     * `exchange` issues it another credential from another session, as signing in again would.
     */
    async machine(db: Directory, account: string, session: string) {
      const host = keyPair();
      const id = hostId(host.publicKey);
      await db
        .prepare(
          "INSERT INTO machines (host_id, account_id, name, platform, created_at, last_seen_at) VALUES (?, ?, 'Team box', 'linux', 1, 1)",
        )
        .bind(id, account)
        .run();
      const exchange = async (from: string) => {
        const credential = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
        const exchangeKey = (await keys()).exchangeKey ?? "";
        const issued = await call(from, "POST", "/v1/machine-credentials", {
          hostId: id,
          hostKey: encodeBase64url(host.publicKey),
          credential,
          proof: machineCredentialProof({
            hostPrivateKey: host.privateKey,
            exchangeKey,
            hostId: id,
            credential,
          }),
        });
        if (issued.status !== 201 && issued.status !== 200)
          throw new Error(`Machine credential failed: ${issued.status}`);
        return credential;
      };
      return { hostId: id, credential: await exchange(session), exchange, host };
    },
    /**
     * The machine's consent to join `org`, as its daemon gives it to a socket that proved
     * `account` is its owner: signed with its host key, for five minutes, under a fresh nonce.
     */
    async consent(
      box: { hostId: string; host: ReturnType<typeof keyPair> },
      org: string,
      account: string,
    ) {
      const terms = {
        hostId: box.hostId,
        org,
        account,
        nonce: encodeBase64url(crypto.getRandomValues(new Uint8Array(16))),
        expiresAt: Date.now() + ORG_ENROLL_LIFETIME_MS,
      };
      const exchangeKey = (await keys()).exchangeKey ?? "";
      return {
        ...terms,
        hostKey: encodeBase64url(box.host.publicKey),
        proof: orgEnrollProof({ hostPrivateKey: box.host.privateKey, exchangeKey, consent: terms }),
      };
    },
    /**
     * `box`'s request for `credential` as its organization credential in `org` (ADR 0206 §2.1),
     * proven with its host key (or `proofHost`'s, to forge one) at `at`; the status and body.
     */
    async orgCredential(
      box: { hostId: string; host: ReturnType<typeof keyPair> },
      org: string,
      credential: string,
      options: { at?: number; proofHost?: ReturnType<typeof keyPair> } = {},
    ) {
      const at = options.at ?? Date.now();
      const exchangeKey = (await keys()).exchangeKey ?? "";
      return call(undefined, "POST", `/v1/orgs/${org}/hosts/${box.hostId}/credential`, {
        hostKey: encodeBase64url(box.host.publicKey),
        credential,
        at,
        proof: orgHostCredentialProof({
          hostPrivateKey: (options.proofHost ?? box.host).privateKey,
          exchangeKey,
          terms: { hostId: box.hostId, org, credential, at },
        }),
      });
    },
    /** Enrolls `box` into `org` with `consent`; the status and body. */
    enroll: (token: string, org: string, box: { hostId: string }, consent: unknown) =>
      call(token, "POST", `/v1/orgs/${org}/hosts`, { hostId: box.hostId, consent }),
  };
}
