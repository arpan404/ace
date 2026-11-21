import { GrantKeySet, encodeBase64url } from "@ace/account-grant";
import { machineCredentialProof } from "@ace/account-grant/machine-proof";
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
  const keys = async () => GrantKeySet.parse(await (await fetch(`${http}/v1/keys`)).json());
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
     */
    async machine(db: D1Database, account: string, session: string) {
      const host = keyPair();
      const id = hostId(host.publicKey);
      await db
        .prepare(
          "INSERT INTO machines (host_id, account_id, name, platform, created_at, last_seen_at) VALUES (?, ?, 'Team box', 'linux', 1, 1)",
        )
        .bind(id, account)
        .run();
      const credential = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
      const exchangeKey = (await keys()).exchangeKey ?? "";
      const issued = await call(session, "POST", "/v1/machine-credentials", {
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
      return { hostId: id, credential };
    },
  };
}
