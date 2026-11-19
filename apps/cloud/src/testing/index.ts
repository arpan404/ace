import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { launchWorker, upgrade } from "./worker.ts";

export { fakeWorkos, type WorkosUser } from "./fake-workos.ts";
export { signInThroughWorker } from "./sign-in.ts";

/** The Worker under Miniflare, as other workspaces' tests see it: its URLs and nothing internal. */
export type RelayWorker = {
  http: string;
  relayUrl: string;
  /** Every sign-in so far happened `ms` earlier: none is fresh any more (ADR 0174 §2). */
  ageSignIns(ms: number): Promise<void>;
  close(): Promise<void>;
};

/** Starts ace's relay Worker under real workerd with local D1, signing in through `workosUrl`. */
export async function startRelayWorker(options: { workosUrl: string }): Promise<RelayWorker> {
  const { http, relayUrl, close, harness } = await launchWorker({ workosUrl: options.workosUrl });
  // Typed here, not with the Worker's `Env`: other workspaces' tests load this without Workers types.
  type Accounts = {
    ACCOUNTS: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };
  };
  const env = await harness.getWorker<Accounts>().getEnv();
  return {
    http,
    relayUrl,
    async ageSignIns(ms) {
      await env.ACCOUNTS.prepare("UPDATE sessions SET signed_in = signed_in - ?").bind(ms).run();
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
