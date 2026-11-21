import {
  GRANT_LIFETIME_MS,
  GRANT_SUBPROTOCOL_PREFIX,
  signMemberGrant,
  type MemberGrantClaims,
} from "@ace/account-grant";
import { grantKey, launchWorker, upgrade } from "./worker.ts";

export { fakeWorkos, type WorkosUser } from "./fake-workos.ts";
export { signInThroughWorker } from "./sign-in.ts";
export { orgCalls, workosUser } from "./org-calls.ts";

/** The Worker under Miniflare, as other workspaces' tests see it: its URLs and nothing internal. */
export type RelayWorker = {
  http: string;
  relayUrl: string;
  /** Every sign-in so far happened `ms` earlier: none is fresh any more (ADR 0174 §2). */
  ageSignIns(ms: number): Promise<void>;
  /** The minute cron: the organization members mirror catches up with WorkOS (ADR 0206). */
  events(): Promise<void>;
  /** The machine directory knows `hostId` on `account`, as the relay records it on connect. */
  seeMachine(hostId: string, account: string): Promise<void>;
  /**
   * A member grant signed with this Worker's grant key, as the backend would sign one, for
   * claims the backend itself would never grant (another organization's, for one).
   */
  mintMember(
    claims: Omit<MemberGrantClaims, "v" | "kid" | "kind" | "aud" | "standing" | "iat" | "exp">,
    at?: number,
  ): string;
  close(): Promise<void>;
};

/** Starts ace's relay Worker under real workerd with local D1, signing in through `workosUrl`. */
export async function startRelayWorker(options: { workosUrl: string }): Promise<RelayWorker> {
  const { http, relayUrl, close, harness } = await launchWorker({ workosUrl: options.workosUrl });
  // Typed here, not with the Worker's `Env`: other workspaces' tests load this without Workers types.
  type Accounts = {
    ACCOUNTS: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };
  };
  const worker = harness.getWorker<Accounts>();
  const env = await worker.getEnv();
  return {
    http,
    relayUrl,
    async ageSignIns(ms) {
      await env.ACCOUNTS.prepare("UPDATE sessions SET signed_in = signed_in - ?").bind(ms).run();
    },
    async events() {
      await worker.scheduled({ cron: "* * * * *" });
    },
    async seeMachine(hostId, account) {
      await env.ACCOUNTS.prepare(
        "INSERT OR IGNORE INTO machines (host_id, account_id, name, platform, created_at, last_seen_at) VALUES (?, ?, 'Team box', 'linux', 1, 1)",
      )
        .bind(hostId, account)
        .run();
    },
    mintMember(claims, at = Date.now()) {
      return signMemberGrant({ ...claims, iat: at, exp: at + GRANT_LIFETIME_MS }, grantKey);
    },
    close,
  };
}

/**
 * Opens a raw relay upgrade, offering `grant` as the `ace.grant.` subprotocol. Resolves with the
 * HTTP status of a refused upgrade, or the close code and reason of an accepted-then-closed one.
 */
export function relayUpgrade(
  url: string,
  grant: string,
): Promise<{ status: number } | { code: number; reason: string; protocol: string }> {
  return upgrade(url, [GRANT_SUBPROTOCOL_PREFIX + grant]);
}
