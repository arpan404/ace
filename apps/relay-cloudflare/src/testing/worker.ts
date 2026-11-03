import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { WebSocket } from "ws";
import { encodeBase64url } from "@ace/account-grant";

// Kept free of Worker sources (and so of Cloudflare's global types): other workspaces' tests
// import this through `@ace/relay-cloudflare/testing`.

/** The grant signing key the test Worker is configured with. */
export const grantKey = { id: "test", privateKey: crypto.getRandomValues(new Uint8Array(32)) };

export const allowedOrigin = "https://app.example";
/** The test Worker's public URL: the Origin its own sign-in page posts with. */
export const publicUrl = "http://127.0.0.1";

/**
 * The Worker under real workerd (Miniflare), with local D1 migrated. `accounts: false` runs it
 * with no account settings at all; `previousGrantKey` sets `ACE_GRANT_PREVIOUS_KEY`.
 */
export async function launchWorker(
  options: { accounts?: boolean; workosUrl?: string; previousGrantKey?: string } = {},
) {
  const secrets: Record<string, string> =
    options.accounts === false
      ? {}
      : {
          ACE_ACCOUNT_PUBLIC_URL: publicUrl,
          ACE_ACCOUNT_ALLOWED_ORIGINS: `${allowedOrigin},app://ace`,
          WORKOS_CLIENT_ID: "client_test",
          WORKOS_API_KEY: "sk_test_backend",
          WORKOS_API_URL: options.workosUrl ?? "http://127.0.0.1:9",
          ACE_ACCOUNT_ENCRYPTION_KEY: "ab".repeat(32),
          ACE_GRANT_KEY: `${grantKey.id}:${encodeBase64url(grantKey.privateKey)}`,
          ...(options.previousGrantKey ? { ACE_GRANT_PREVIOUS_KEY: options.previousGrantKey } : {}),
        };
  const harness = createTestHarness({
    workers: [{ configPath: fileURLToPath(import.meta.resolve("../../wrangler.jsonc")), secrets }],
  });
  const { url } = await harness.listen();
  await harness.getWorker().applyD1Migrations("ACCOUNTS");
  const http = url.toString().replace(/\/$/, "");
  return {
    http,
    relayUrl: http.replace(/^http/, "ws"),
    harness,
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
