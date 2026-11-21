import { SESSION_LIFETIME_MS } from "./login.ts";
import type { OrgStore } from "./org-store.ts";
import type { Principal } from "./principal.ts";
import type { SessionStore } from "./sessions.ts";
import type { AccountProvider } from "./workos.ts";
import { OrgRefusedError } from "./workos.ts";
import type { WorkosOrgs } from "./workos-orgs.ts";
import type { WorkosTokenVerifier } from "./workos-jwt.ts";
import { TokenError } from "./workos-jwt.ts";

/** WorkOS's answer on a session entering an organization, or why there is none. */
export type OrgCheck =
  | { ok: true; role: string; sid: string }
  | { ok: false; error: "not_member" | "org_sign_in_required" | "busy" };

/** How long one reader may spend a session's refresh token before another may try. */
const REFRESH_LEASE_MS = 15_000;
/** Waits for a refresh another reader holds: the lease is short, the wait shorter. */
const LEASE_TRIES = 10;
const LEASE_WAIT_MS = 200;

/**
 * Decides whether a session may act in an organization (ADR 0206 §1.4). Only an ace session ever
 * does, never a machine credential. The mirror refuses at once a membership it knows isn't
 * active; otherwise the answer is WorkOS's: a refresh of the session's WorkOS refresh token with
 * `organization_id`, whose access token must verify against WorkOS's JWKS and name this account
 * and organization. That answer is kept in `org_checks` and reused for 60 seconds.
 *
 * The refresh spends the session's single-use refresh token, so it takes the same D1 lease as a
 * personal refresh and stores the rotated token before anything else is decided. A refusal never
 * ends the session: personal never depends on an organization.
 */
export function orgChecker(deps: {
  store: Pick<SessionStore, "get" | "lease" | "release" | "rotate" | "remove">;
  provider: Pick<AccountProvider, "refreshInto">;
  verifier: WorkosTokenVerifier;
  orgs: OrgStore;
  workos: Pick<WorkosOrgs, "findMembership">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}) {
  const { store, orgs, now } = deps;
  const inflight = new Map<string, Promise<OrgCheck>>();

  async function leased(hash: string): Promise<boolean> {
    for (let attempt = 0; attempt < LEASE_TRIES; attempt++) {
      if (await store.lease(hash, now(), REFRESH_LEASE_MS)) return true;
      await deps.sleep(LEASE_WAIT_MS);
    }
    return false;
  }

  async function ask(hash: string, account: string, org: string): Promise<OrgCheck> {
    const stored = await store.get(hash, now());
    if (!stored) return { ok: false, error: "not_member" };
    if (!(await leased(hash))) {
      // Another reader may have just asked WorkOS for this very organization.
      const recent = await orgs.check(hash, org, now());
      return recent
        ? { ok: true, role: recent.role, sid: recent.sid }
        : { ok: false, error: "busy" };
    }
    let identity;
    try {
      identity = await deps.provider.refreshInto(await stored.refresh(), org);
    } catch (error) {
      await store.release(hash);
      if (error instanceof OrgRefusedError) {
        await orgs.dropCheck(hash, org);
        return { ok: false, error: "org_sign_in_required" };
      }
      throw error;
    }
    // The old refresh token is spent: keep the new one before deciding anything else.
    if (identity.account.id !== account) {
      await store.remove(hash);
      return { ok: false, error: "not_member" };
    }
    const expiresAt = Math.max(stored.expiresAt, now() + SESSION_LIFETIME_MS);
    if (
      !(await store.rotate(
        hash,
        identity.account,
        identity.refreshToken,
        expiresAt,
        identity.pictureUrl,
      ))
    )
      return { ok: false, error: "not_member" };
    let token;
    try {
      token = await deps.verifier.verify(identity.accessToken);
    } catch (error) {
      if (error instanceof TokenError) {
        console.warn(JSON.stringify({ event: "workos_token_refused", reason: error.message }));
        return { ok: false, error: "org_sign_in_required" };
      }
      throw error;
    }
    if (token.account !== account || token.org !== org)
      return { ok: false, error: "org_sign_in_required" };
    await orgs.putCheck({ session: hash, org, account, role: token.role, sid: token.sid }, now());
    return { ok: true, role: token.role, sid: token.sid };
  }

  /** A membership WorkOS confirmed that the mirror hasn't seen yet (a join): mirror it now. */
  async function mirror(account: string, org: string) {
    try {
      const found = await deps.workos.findMembership(account, org);
      if (!found || found.user_id !== account || found.organization_id !== org) return;
      await orgs.run([
        orgs.upsertingMember(
          {
            org,
            account,
            membership: found.id,
            role: found.role?.slug ?? "member",
            status: found.status,
            directoryManaged: found.directory_managed === true,
            email: found.user?.email ?? undefined,
            name:
              [found.user?.first_name, found.user?.last_name].filter(Boolean).join(" ") ||
              undefined,
            version: found.updated_at ?? new Date(now()).toISOString(),
          },
          now(),
        ),
      ]);
    } catch {
      // The events cron mirrors it within a minute anyway.
    }
  }

  return {
    /** Mirrors the account's membership of `org` from WorkOS now, as a join just made it. */
    mirror,
    async check(principal: Principal, org: string): Promise<OrgCheck> {
      if (principal.kind !== "session") return { ok: false, error: "not_member" };
      const account = principal.account.id;
      const member = await orgs.member(org, account);
      if (member && member.status !== "active") return { ok: false, error: "not_member" };
      const recent = await orgs.check(principal.hash, org, now());
      if (recent) return { ok: true, role: recent.role, sid: recent.sid };
      const key = `${principal.hash}:${org}`;
      let pending = inflight.get(key);
      if (!pending) {
        pending = ask(principal.hash, account, org).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const answer = await pending;
      if (answer.ok && !member) await mirror(account, org);
      return answer;
    },
  };
}
export type OrgChecker = ReturnType<typeof orgChecker>;
