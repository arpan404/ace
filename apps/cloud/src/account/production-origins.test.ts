import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { encodeBase64url } from "@ace/account-grant";
import { ACE_WEB_SIGN_IN_PATH } from "@ace/protocol/ace-account";
import { readAccountSetup } from "./config.ts";
import { allowedReturnTo } from "./return-to.ts";

// Production's account settings as deployed: the vars from wrangler.jsonc's `env.production`,
// with stand-in secrets.
const production = unstable_readConfig(
  { config: fileURLToPath(import.meta.resolve("../../wrangler.jsonc")), env: "production" },
  { hideWarnings: true },
);
const vars = Object.fromEntries(
  Object.entries(production.vars).flatMap(([key, value]) =>
    typeof value === "string" ? [[key, value]] : [],
  ),
);
const setup = readAccountSetup({
  ...vars,
  WORKOS_CLIENT_ID: "client_123456",
  WORKOS_API_KEY: "sk_test",
  ACE_ACCOUNT_ENCRYPTION_KEY: "ab".repeat(32),
  ACE_GRANT_KEY: `k2026:${encodeBase64url(new Uint8Array(32).fill(7))}`,
});

it("production ace cloud signs in the stable and beta web apps and refuses look-alike origins", () => {
  if (setup.status !== "ready") throw new Error("Expected production's account settings to load");
  const origins = setup.config.allowedOrigins;
  for (const origin of ["https://app.acehq.dev", "https://beta.app.acehq.dev"])
    expect(allowedReturnTo(`${origin}${ACE_WEB_SIGN_IN_PATH}`, origins)).toBeDefined();
  for (const origin of [
    "https://beta.ace-web.pages.dev",
    "https://ace-web.pages.dev",
    "http://beta.app.acehq.dev",
    "https://beta.app.acehq.dev.evil.example",
    "https://xbeta.app.acehq.dev",
    "https://beta.app.acehq.dev:8443",
  ])
    expect(allowedReturnTo(`${origin}${ACE_WEB_SIGN_IN_PATH}`, origins)).toBeUndefined();
});
