import { AceGrantRequest } from "@ace/protocol/ace-account";
import {
  GRANT_LIFETIME_MS,
  MARKET_GRANT_ISSUER,
  signCloudGrant,
  signGrant,
  signMarketGrant,
  signMemberGrant,
  signStandingGrant,
} from "@ace/account-grant";
import type { GrantKeySet, GrantSigningKey } from "@ace/account-grant";
import { HostId } from "@ace/relay/wire";
import type { machineStore } from "./machines.ts";
import type { OrgChecker } from "./org-check.ts";
import type { OrgStore } from "./org-store.ts";
import { bearer, fail, json, jsonBody } from "./respond.ts";
import type { Principal, PrincipalReader } from "./principal.ts";
import type { SessionStanding, SessionStore } from "./sessions.ts";

/**
 * Whether a session's grants speak for the person (ADR 0190): only one an app signed in to in a
 * browser after standing was kept, never seen on a machine's disk. A session from before
 * (`legacy`) may sit in any older daemon's file, so it never does: its client signs in again.
 */
export function speaksForPerson(standing: SessionStanding | undefined): boolean {
  return standing === "person";
}

/**
 * Grants and the machine directory (ADR 0111). Every route but the key set needs a live ace
 * session or machine credential (ADR 0190); reading it refreshes with WorkOS, so a signed-out or
 * deleted account stops getting grants at once and loses relay access within one grant lifetime.
 */
export function directoryRoutes(deps: {
  principals: PrincipalReader;
  /** To mark a session a machine kept on its disk, and read its standing as a grant is issued. */
  sessionStore: Pick<SessionStore, "expose" | "standingNow">;
  machines: ReturnType<typeof machineStore>;
  /** Runs after a machine is forgotten, so one still on the relay can list itself again. */
  forgotten?: (hostId: string, accountId: string) => Promise<void>;
  keys: GrantKeySet;
  signingKey: GrantSigningKey;
  now: () => number;
  /** The `iss` a market grant names: this backend's host. */
  issuer?: string;
  /** Organizations (ADR 0206): member grants and market grants that act in an organization. */
  orgs?: { checker: OrgChecker; store: OrgStore };
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
  function orgRefused(org: string, error: "not_member" | "org_sign_in_required" | "busy") {
    if (error === "org_sign_in_required") return json(403, { error, org });
    return error === "busy" ? fail(503, "busy") : fail(403, "not_member");
  }

  /**
   * A member grant (ADR 0206 §2.2): only for the person's own session, with WorkOS's answer
   * under 60 seconds old that the account is an active member, an active mirror row, and `host`
   * one of that organization's hosts. It carries the organization's policy version.
   */
  async function member(principal: Principal, request: AceGrantRequest): Promise<Response> {
    const { org, host, key, subject } = request;
    if (!org || !host || !key) return fail(400, "invalid_request");
    if (principal.kind !== "session" || !deps.orgs) return fail(403, "person_required");
    if (!speaksForPerson(await deps.sessionStore.standingNow(principal.hash, now())))
      return fail(403, "person_required");
    const check = await deps.orgs.checker.check(principal, org);
    if (!check.ok) return orgRefused(org, check.error);
    const store = deps.orgs.store;
    if ((await store.member(org, principal.account.id))?.status !== "active")
      return fail(403, "not_member");
    if ((await store.hostOrg(host)) !== org) return fail(403, "not_org_host");
    const policy = (await store.policy(org))?.version ?? 0;
    const iat = now();
    const exp = iat + GRANT_LIFETIME_MS;
    const token = signMemberGrant(
      { org, role: check.role, account: principal.account.id, subject, host, key, policy, iat, exp },
      signingKey,
    );
    return json(200, { token, expiresAt: exp });
  }

  return {
    /** GET /v1/keys — public keys only. */
    keys: () => json(200, keys),

    /**
     * POST /v1/grants. What a principal gets (ADR 0190):
     *
     * - A machine credential: `machine` grants for its own host only; device grants in format 2
     *   with a machine's standing, which older daemons (which treat any format 1 device grant as
     *   the person) refuse; market grants as `machine`, which the market refuses for sensitive
     *   actions.
     * - A session a machine kept (`exposed`), or one from before standing was kept (`legacy`): the
     *   same, but `machine` grants for any host, as an older daemon asks for its own.
     * - The person's session: format 1 device grants, and with `host` and `key` the person's
     *   format 2 grant beside it.
     *
     * A session asking for a `machine` grant is kept by an older daemon, so it is marked exposed
     * first; the standing is then read again for this decision, never from before it.
     */
    grant: (request: Request) =>
      authenticated(request, async (principal) => {
        const { account, signedInAt } = principal;
        const parsed = AceGrantRequest.safeParse(await jsonBody(request, 4096));
        if (!parsed.success) return fail(400, "invalid_request");
        const { kind, subject, purpose, host, key, action, org } = parsed.data;
        if (kind === "member") return member(principal, parsed.data);
        if (org !== undefined && purpose !== "market-publish") return fail(400, "invalid_request");
        if (kind === "machine" && !HostId.safeParse(subject).success)
          return fail(400, "invalid_request");
        if (purpose === "spade-cloud" && kind !== "machine") return fail(400, "invalid_request");
        if (action !== undefined && purpose !== "market-publish")
          return fail(400, "invalid_request");
        if (principal.kind === "machine" && kind === "machine" && subject !== principal.hostId)
          return fail(403, "other_machine");
        if (principal.kind === "session" && kind === "machine")
          await deps.sessionStore.expose(principal.hash);
        const iat = now();
        const standing =
          principal.kind === "session"
            ? await deps.sessionStore.standingNow(principal.hash, iat)
            : "exposed";
        // Signed out, expired or retired since it was read: nothing is issued, in any format.
        if (standing === undefined) return fail(401, "unauthenticated");
        const person = speaksForPerson(standing);
        // Format 1 device grants only ever for the person's own session: older daemons take any
        // format 1 device grant as the person, so a session that may sit on a disk never gets one.
        const formatOne = person;
        // Publishing only ever as an account whose email WorkOS verified (ADR 0174 §2).
        if (purpose === "market-publish" && account.emailVerified !== true)
          return fail(403, "email_unverified");
        // Only the person's own session may name a sensitive market request.
        if (action !== undefined && !person) return fail(403, "person_required");
        // Acting in an organization needs the person's session and WorkOS's answer, fresh.
        if (org !== undefined) {
          if (!person || !deps.orgs) return fail(403, "person_required");
          const check = await deps.orgs.checker.check(principal, org);
          if (!check.ok) return orgRefused(org, check.error);
        }
        const exp = iat + GRANT_LIFETIME_MS;
        const claims = { kind, account: account.id, subject, iat, exp };
        if (purpose === "spade-cloud")
          return json(200, { token: signCloudGrant(claims, signingKey), expiresAt: exp });
        if (purpose === "market-publish") {
          const token = signMarketGrant(
            {
              ...claims,
              // Anything but the person's own session publishes as a machine.
              kind: person ? kind : "machine",
              iss: issuer,
              emailVerified: true,
              authAt: signedInAt,
              ...(action !== undefined ? { action } : {}),
              ...(org !== undefined ? { org } : {}),
            },
            signingKey,
          );
          return json(200, { token, expiresAt: exp });
        }
        if (kind === "machine")
          return json(200, { token: signGrant(claims, signingKey), expiresAt: exp });
        if (!formatOne)
          return json(200, {
            token: signStandingGrant(
              {
                standing: "machine",
                account: account.id,
                subject,
                ...(host ? { host } : {}),
                iat,
                exp,
              },
              signingKey,
            ),
            expiresAt: exp,
          });
        const standingGrant =
          person && host && key
            ? signStandingGrant(
                { standing: "person", account: account.id, subject, host, key, iat, exp },
                signingKey,
              )
            : undefined;
        return json(200, {
          token: signGrant(claims, signingKey),
          expiresAt: exp,
          ...(standingGrant ? { standing: standingGrant } : {}),
        });
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
