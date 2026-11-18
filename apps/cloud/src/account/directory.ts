import { AceGrantRequest } from "@ace/protocol/ace-account";
import {
  GRANT_LIFETIME_MS,
  MARKET_GRANT_ISSUER,
  signCloudGrant,
  signGrant,
  signMarketGrant,
  signStandingGrant,
} from "@ace/account-grant";
import type { GrantKeySet, GrantSigningKey } from "@ace/account-grant";
import { HostId } from "@ace/relay/wire";
import type { machineStore } from "./machines.ts";
import { bearer, fail, json, jsonBody } from "./respond.ts";
import type { Principal, PrincipalReader } from "./principal.ts";
import type { SessionStore } from "./sessions.ts";

/**
 * Whether a principal's device grants carry the person's standing (ADR 0189): a session signed
 * in after standing was kept, never written to a machine's disk. A session from before is the
 * person's only until `legacyPersonUntil`, the transition the deployment chose (none by default).
 */
export function speaksForPerson(
  principal: Principal,
  now: number,
  legacyPersonUntil: number | undefined,
): boolean {
  if (principal.kind !== "session") return false;
  if (principal.standing === "person") return true;
  return (
    principal.standing === "legacy" && legacyPersonUntil !== undefined && now < legacyPersonUntil
  );
}

/**
 * Grants and the machine directory (ADR 0111). Every route but the key set needs a live ace
 * session or machine credential (ADR 0189); reading it refreshes with WorkOS, so a signed-out or
 * deleted account stops getting grants at once and loses relay access within one grant lifetime.
 */
export function directoryRoutes(deps: {
  principals: PrincipalReader;
  /** To mark a session a machine kept on its disk. */
  sessionStore: Pick<SessionStore, "expose">;
  /** Until when sessions from before ADR 0189 still speak for the person; undefined: never. */
  legacyPersonUntil?: number | undefined;
  machines: ReturnType<typeof machineStore>;
  /** Runs after a machine is forgotten, so one still on the relay can list itself again. */
  forgotten?: (hostId: string, accountId: string) => Promise<void>;
  keys: GrantKeySet;
  signingKey: GrantSigningKey;
  now: () => number;
  /** The `iss` a market grant names: this backend's host. */
  issuer?: string;
}) {
  const { principals, machines, keys, signingKey, now } = deps;
  const issuer = deps.issuer ?? MARKET_GRANT_ISSUER;
  async function authenticated(
    request: Request,
    then: (principal: Principal) => Promise<Response>,
  ): Promise<Response> {
    const token = bearer(request);
    const principal = token ? await principals.read(token) : undefined;
    return principal ? then(principal) : fail(401, "unauthenticated");
  }
  return {
    /** GET /v1/keys — public keys only. */
    keys: () => json(200, keys),

    /** POST /v1/grants */
    grant: (request: Request) =>
      authenticated(request, async (principal) => {
        const { account, signedInAt } = principal;
        const parsed = AceGrantRequest.safeParse(await jsonBody(request, 4096));
        if (!parsed.success) return fail(400, "invalid_request");
        const { kind, subject, purpose } = parsed.data;
        if (kind === "machine" && !HostId.safeParse(subject).success)
          return fail(400, "invalid_request");
        if (purpose === "spade-cloud" && kind !== "machine") return fail(400, "invalid_request");
        // A machine credential speaks for its own machine only (ADR 0189).
        if (principal.kind === "machine" && kind === "machine" && subject !== principal.hostId)
          return fail(403, "other_machine");
        // A session asking as a machine is one an older daemon keeps in its session file: it has
        // been on a machine's disk, so it never speaks for the person again.
        if (principal.kind === "session" && kind === "machine" && principal.standing !== "exposed")
          await deps.sessionStore.expose(principal.hash);
        // Publishing only ever as an account whose email WorkOS verified (ADR 0174 §2).
        if (purpose === "market-publish" && account.emailVerified !== true)
          return fail(403, "email_unverified");
        const iat = now();
        const exp = iat + GRANT_LIFETIME_MS;
        const claims = { kind, account: account.id, subject, iat, exp };
        const token =
          purpose === "spade-cloud"
            ? signCloudGrant(claims, signingKey)
            : purpose === "market-publish"
              ? signMarketGrant(
                  { ...claims, iss: issuer, emailVerified: true, authAt: signedInAt },
                  signingKey,
                )
              : signGrant(claims, signingKey);
        // A device grant comes with its standing grant: whose session asked (ADR 0189).
        const standing =
          kind === "device" && purpose === undefined
            ? signStandingGrant(
                {
                  standing: speaksForPerson(principal, iat, deps.legacyPersonUntil)
                    ? "person"
                    : "machine",
                  account: account.id,
                  subject,
                  iat,
                  exp,
                },
                signingKey,
              )
            : undefined;
        return json(200, { token, expiresAt: exp, ...(standing ? { standing } : {}) });
      }),

    /** GET /v1/machines */
    list: (request: Request) =>
      authenticated(request, async ({ account }) =>
        json(200, { machines: await machines.list(account.id) }),
      ),

    /**
     * DELETE /v1/machines/:hostId — this account's machines only. The list names the machines
     * signed in to the account, so one still registered on the relay registers again and comes
     * back; forgetting is for machines that are gone.
     */
    forget: (request: Request, hostId: string) =>
      authenticated(request, async ({ kind, account }) => {
        // Changing the account's list is the person's, never a machine's.
        if (kind === "machine") return fail(403, "machine_credential");
        if (!(await machines.forget(hostId, account.id))) return fail(404, "not_found");
        await deps.forgotten?.(hostId, account.id);
        return json(200, { ok: true });
      }),
  };
}
