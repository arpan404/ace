import { z } from "zod";
import { AceAccountOrigin } from "@ace/protocol/ace-account";
import { decodeBase64url, grantPublicKey } from "@ace/account-grant";
import type { GrantKeySet, GrantSigningKey } from "@ace/account-grant";

const Origin = z.union([z.literal("app://ace"), AceAccountOrigin]);

/**
 * `ACE_GRANT_KEY` is `<key id>:<base64url Ed25519 seed>`, for example
 * `k2026a:` followed by 43 base64url characters (32 bytes). The key id is published with the
 * public key at `/v1/keys`; a new id rotates the key.
 */
const GrantKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{43}$/)
  .transform((value): GrantSigningKey => {
    const [id = "", seed = ""] = value.split(":");
    return { id, privateKey: decodeBase64url(seed) };
  });

export const AccountConfig = z.object({
  publicUrl: AceAccountOrigin,
  clientId: z.string().startsWith("client_").min(8),
  apiKey: z.string().min(1),
  workosUrl: AceAccountOrigin,
  encryptionKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
  grantKey: GrantKey,
  allowedOrigins: z.array(Origin).min(1),
});
export type AccountConfig = z.infer<typeof AccountConfig>;

/**
 * `off`: nothing configured. `invalid`: some settings are present but not all of them, or one
 * is malformed. Both fail closed: account routes answer 503 and the relay admits no host or
 * client, since the hosted relay requires an account on both ends.
 */
export type AccountSetup =
  | { status: "off" }
  | { status: "invalid" }
  | { status: "ready"; config: AccountConfig; keys: GrantKeySet };

const required = [
  "ACE_ACCOUNT_PUBLIC_URL",
  "ACE_ACCOUNT_ALLOWED_ORIGINS",
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "ACE_ACCOUNT_ENCRYPTION_KEY",
  "ACE_GRANT_KEY",
] as const;

export type AccountEnv = { [Key in (typeof required)[number] | "WORKOS_API_URL"]?: string };

export function readAccountSetup(env: AccountEnv): AccountSetup {
  if (required.every((key) => env[key] === undefined || env[key] === "")) return { status: "off" };
  const allowed = env.ACE_ACCOUNT_ALLOWED_ORIGINS;
  const parsed = AccountConfig.safeParse({
    publicUrl: env.ACE_ACCOUNT_PUBLIC_URL,
    clientId: env.WORKOS_CLIENT_ID,
    apiKey: env.WORKOS_API_KEY,
    workosUrl: env.WORKOS_API_URL || "https://api.workos.com",
    encryptionKey: env.ACE_ACCOUNT_ENCRYPTION_KEY,
    grantKey: env.ACE_GRANT_KEY,
    allowedOrigins:
      typeof allowed === "string"
        ? allowed
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined,
  });
  if (!parsed.success) return { status: "invalid" };
  return {
    status: "ready",
    config: parsed.data,
    keys: { keys: [grantPublicKey(parsed.data.grantKey)] },
  };
}
