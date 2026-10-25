import { z } from "zod";
import { AceAccountOrigin } from "@ace/protocol/ace-account";

const Origin = z.union([z.literal("app://ace"), AceAccountOrigin]);

export const AccountConfig = z.object({
  publicUrl: AceAccountOrigin,
  clientId: z.string().startsWith("client_").min(8),
  apiKey: z.string().min(1),
  encryptionKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
  dataDir: z.string().min(1),
  allowedOrigins: z.array(Origin).min(1),
});
export type AccountConfig = z.infer<typeof AccountConfig>;

/** Partial configuration fails startup instead of silently serving an unprotected account API. */
export function readAccountConfig(
  env: Record<string, string | undefined>,
): AccountConfig | undefined {
  const keys = [
    "ACE_ACCOUNT_PUBLIC_URL",
    "WORKOS_CLIENT_ID",
    "WORKOS_API_KEY",
    "ACE_ACCOUNT_ENCRYPTION_KEY",
    "ACE_ACCOUNT_DATA_DIR",
    "ACE_ACCOUNT_ALLOWED_ORIGINS",
  ];
  if (keys.every((key) => env[key] === undefined)) return undefined;
  return AccountConfig.parse({
    publicUrl: env.ACE_ACCOUNT_PUBLIC_URL,
    clientId: env.WORKOS_CLIENT_ID,
    apiKey: env.WORKOS_API_KEY,
    encryptionKey: env.ACE_ACCOUNT_ENCRYPTION_KEY,
    dataDir: env.ACE_ACCOUNT_DATA_DIR,
    allowedOrigins: env.ACE_ACCOUNT_ALLOWED_ORIGINS?.split(",").map((value) => value.trim()),
  });
}
