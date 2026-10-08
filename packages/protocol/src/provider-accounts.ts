import { z } from "zod";
import {
  AccountSummary,
  NativeAccountProvider,
  AccountId,
  AccountShortLabel,
  AccountBadgeColor,
} from "./accounts.ts";
import { ProviderLoginProgress } from "./provider-login.ts";

import { AccountAuthMethod, ApiKeySupport } from "./account-auth.ts";
export { AccountAuthMethod, ApiKeySupport } from "./account-auth.ts";
const id = z.string().min(1).max(128);
const target = { provider: NativeAccountProvider, instanceId: AccountId };
const label = z.string().min(1).max(128).regex(/\S/);
export const AccountLoginMethod = z.enum(["login", "api_key"]);
export const ApiKeyUpstream = z.enum(["openai", "anthropic", "openrouter", "opencode"]);
export const ProviderAccountsRequest = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("provider.accounts.list"),
    requestId: id,
    provider: NativeAccountProvider,
  }),
  z.strictObject({
    type: z.literal("provider.accounts.add"),
    requestId: id,
    provider: NativeAccountProvider,
    label: label.optional(),
    method: AccountLoginMethod,
    upstream: ApiKeyUpstream.optional(),
  }),
  z.strictObject({
    type: z.literal("provider.accounts.rename"),
    requestId: id,
    ...target,
    label,
    shortLabel: AccountShortLabel.optional(),
    badgeColor: AccountBadgeColor.nullable().optional(),
  }),
  z.strictObject({ type: z.literal("provider.accounts.setDefault"), requestId: id, ...target }),
  z.strictObject({
    type: z.literal("provider.accounts.remove"),
    requestId: id,
    ...target,
    confirm: z.literal(true),
    deleteHome: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal("provider.accounts.reauth"),
    requestId: id,
    ...target,
    method: AccountLoginMethod.default("login"),
    upstream: ApiKeyUpstream.optional(),
  }),
]);
export type ProviderAccountsRequest = z.infer<typeof ProviderAccountsRequest>;
export const ProviderAccountSummary = AccountSummary.extend({
  authMethod: AccountAuthMethod,
  signedInAs: z.string().max(256).optional(),
  status: z.enum(["available", "near_limit", "exhausted", "logged_out", "unknown"]),
  apiKey: ApiKeySupport,
  usageSummary: AccountSummary.shape.quota.shape.usage,
});
export type ProviderAccountSummary = z.infer<typeof ProviderAccountSummary>;
export const ProviderAccountsResult = z.object({
  type: z.literal("provider.accounts.result"),
  requestId: id,
  result: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      accounts: z.array(ProviderAccountSummary).max(256),
      apiKey: ApiKeySupport,
      progress: ProviderLoginProgress.optional(),
    }),
    z.object({
      ok: z.literal(false),
      error: z.enum(["forbidden", "unavailable", "busy", "not_found", "unsupported", "failed"]),
      instanceId: AccountId.optional(),
    }),
  ]),
});
export type ProviderAccountsResult = z.infer<typeof ProviderAccountsResult>;
