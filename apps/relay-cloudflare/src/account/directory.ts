import { AceGrantRequest } from "@ace/protocol/ace-account";
import { GRANT_LIFETIME_MS, signGrant } from "@ace/account-grant";
import type { GrantKeySet, GrantSigningKey } from "@ace/account-grant";
import { HostId } from "@ace/relay/wire";
import type { machineStore } from "./machines.ts";
import { bearer, fail, json, jsonBody } from "./respond.ts";
import type { ActiveSession, SessionReader } from "./session.ts";

/**
 * Grants and the machine directory (ADR 0111). Every route but the key set needs a live ace
 * session; reading it refreshes with WorkOS, so a signed-out or deleted account stops getting
 * grants at once and loses relay access within one grant lifetime.
 */
export function directoryRoutes(deps: {
  sessions: SessionReader;
  machines: ReturnType<typeof machineStore>;
  /** Runs after a machine is forgotten, so one still on the relay can list itself again. */
  forgotten?: (hostId: string, accountId: string) => Promise<void>;
  keys: GrantKeySet;
  signingKey: GrantSigningKey;
  now: () => number;
}) {
  const { sessions, machines, keys, signingKey, now } = deps;
  async function authenticated(
    request: Request,
    then: (session: ActiveSession) => Promise<Response>,
  ): Promise<Response> {
    const token = bearer(request);
    const session = token ? await sessions.read(token) : undefined;
    return session ? then(session) : fail(401, "unauthenticated");
  }
  return {
    /** GET /v1/keys — public keys only. */
    keys: () => json(200, keys),

    /** POST /v1/grants */
    grant: (request: Request) =>
      authenticated(request, async ({ account }) => {
        const parsed = AceGrantRequest.safeParse(await jsonBody(request, 4096));
        if (!parsed.success) return fail(400, "invalid_request");
        const { kind, subject } = parsed.data;
        if (kind === "machine" && !HostId.safeParse(subject).success)
          return fail(400, "invalid_request");
        const iat = now();
        const exp = iat + GRANT_LIFETIME_MS;
        const token = signGrant({ kind, account: account.id, subject, iat, exp }, signingKey);
        return json(200, { token, expiresAt: exp });
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
      authenticated(request, async ({ account }) => {
        if (!(await machines.forget(hostId, account.id))) return fail(404, "not_found");
        await deps.forgotten?.(hostId, account.id);
        return json(200, { ok: true });
      }),
  };
}
