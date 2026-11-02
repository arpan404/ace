import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { WebSocket } from "ws";
import { GRANT_LIFETIME_MS, encodeBase64url, signGrant } from "@ace/account-grant";
import type { GrantKind } from "@ace/account-grant";
import type { Env } from "../env.ts";

/** The grant signing key the test Worker is configured with. */
export const grantKey = { id: "test", privateKey: crypto.getRandomValues(new Uint8Array(32)) };

export const allowedOrigin = "https://app.example";

/** Signs a grant as the account backend would, for relay tests that need no sign-in. */
export function mint(
  kind: GrantKind,
  account: string,
  subject: string,
  options: { iat?: number; key?: typeof grantKey } = {},
): string {
  const iat = options.iat ?? Date.now();
  return signGrant(
    { kind, account, subject, iat, exp: iat + GRANT_LIFETIME_MS },
    options.key ?? grantKey,
  );
}

/**
 * The Worker under real workerd (Miniflare), with local D1 migrated. `accounts: false` runs it
 * with no account settings at all.
 */
export async function startWorker(options: { accounts?: boolean; workosUrl?: string } = {}) {
  const secrets: Record<string, string> =
    options.accounts === false
      ? {}
      : {
          ACE_ACCOUNT_PUBLIC_URL: "http://127.0.0.1",
          ACE_ACCOUNT_ALLOWED_ORIGINS: `${allowedOrigin},app://ace`,
          WORKOS_CLIENT_ID: "client_test",
          WORKOS_API_KEY: "sk_test_backend",
          WORKOS_API_URL: options.workosUrl ?? "http://127.0.0.1:9",
          ACE_ACCOUNT_ENCRYPTION_KEY: "ab".repeat(32),
          ACE_GRANT_KEY: `${grantKey.id}:${encodeBase64url(grantKey.privateKey)}`,
        };
  const harness = createTestHarness({
    workers: [{ configPath: fileURLToPath(import.meta.resolve("../../wrangler.jsonc")), secrets }],
  });
  const { url } = await harness.listen();
  const worker = harness.getWorker<Env>();
  await worker.applyD1Migrations("ACCOUNTS");
  const env = await worker.getEnv();
  const http = url.toString().replace(/\/$/, "");
  return {
    http,
    relayUrl: http.replace(/^http/, "ws"),
    db: env.ACCOUNTS,
    close: () => harness.close(),
  };
}

/**
 * Opens a raw upgrade. Resolves with the HTTP status of a refused upgrade, or with the close
 * code and reason when the relay accepts and then closes the socket.
 */
export function upgrade(
  url: string,
  protocols: string[] = [],
): Promise<{ status: number } | { code: number; reason: string; protocol: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    socket.once("unexpected-response", (_request, response) => {
      resolve({ status: response.statusCode ?? 0 });
      socket.terminate();
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString(), protocol: socket.protocol }),
    );
  });
}
