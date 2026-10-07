import { z } from "zod";
import { ProviderKind } from "./provider.ts";
import { AccountId } from "./accounts.ts";
import { ProviderStatus } from "./provider-status.ts";

const id = z.string().min(1).max(128);
const target = { provider: ProviderKind, instance: AccountId.optional() };
/** Input is deliberately finite: credential entry is never a provider-login RPC. */
export const ProviderLoginInput = z.union([
  z.strictObject({ confirm: z.literal(true) }),
  z.strictObject({ value: z.literal("enter") }),
  z.strictObject({ choice: z.string().regex(/^[a-z0-9_-]{1,64}$/) }),
]);
export type ProviderLoginInput = z.infer<typeof ProviderLoginInput>;
export const ProviderLoginRequest = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("provider.login.start"), requestId: id, ...target }),
  z.strictObject({ type: z.literal("provider.logout"), requestId: id, ...target }),
  z.strictObject({ type: z.literal("provider.login.terminal"), requestId: id, session: id }),
  z.strictObject({ type: z.literal("provider.login.poll"), requestId: id, session: id }),
  z.strictObject({ type: z.literal("provider.login.cancel"), requestId: id, session: id }),
  z.strictObject({
    type: z.literal("provider.login.input"),
    requestId: id,
    session: id,
    input: ProviderLoginInput,
  }),
]);
export type ProviderLoginRequest = z.infer<typeof ProviderLoginRequest>;
export const ProviderLoginProgress = z.strictObject({
  session: id,
  ...target,
  action: z.enum(["login", "logout"]),
  state: z.enum([
    "starting",
    "awaiting_browser",
    "awaiting_code_entry",
    "awaiting_input",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  expiresAt: z.number().finite().nonnegative(),
  sequence: z.number().int().nonnegative(),
  url: z
    .intersection(z.url().max(8192), z.string().regex(/^(?!.*\s)https:\/\/\S+$/, { abort: true }))
    .optional(),
  userCode: z
    .string()
    .regex(/^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/)
    .optional(),
  prompt: z.string().max(256).optional(),
  choices: z
    .array(
      z.strictObject({ id: z.string().regex(/^[a-z0-9_-]{1,64}$/), label: z.string().max(128) }),
    )
    .max(32)
    .optional(),
  message: z.string().max(256).optional(),
  hint: z.string().max(1024).optional(),
  manual: z
    .strictObject({
      action: z.literal("open_terminal"),
      terminalId: id.optional(),
      command: z.string().max(256),
      instruction: z.string().max(1024),
      instance: AccountId.optional(),
    })
    .optional(),
});
export type ProviderLoginProgress = z.infer<typeof ProviderLoginProgress>;
export const ProviderLoginEvent = z.object({
  type: z.literal("provider.login.progress"),
  progress: ProviderLoginProgress,
});
export const ProviderLoginResult = z.object({
  type: z.literal("provider.login.result"),
  requestId: id,
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), progress: ProviderLoginProgress }),
    z.object({
      ok: z.literal(false),
      error: z.enum(["forbidden", "unavailable", "busy", "not_found", "invalid_input"]),
    }),
  ]),
});
export type ProviderLoginResult = z.infer<typeof ProviderLoginResult>;
export const OnboardingRequest = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("onboarding.query"), requestId: id }),
  z.strictObject({ type: z.literal("onboarding.dismiss"), requestId: id, dismissed: z.boolean() }),
]);
export const OnboardingResult = z.object({
  type: z.literal("onboarding.result"),
  requestId: id,
  result: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      dismissed: z.boolean(),
      providers: z.array(ProviderStatus).max(16),
      ready: z.array(ProviderKind).max(16),
      next: z.object({
        action: z.enum(["start_thread", "sign_in", "install", "refresh", "configure"]),
        provider: ProviderKind.optional(),
      }),
    }),
    z.object({ ok: z.literal(false), error: z.enum(["forbidden", "unavailable"]) }),
  ]),
});
export type OnboardingResult = z.infer<typeof OnboardingResult>;
export const ProvidersChanged = z.object({
  type: z.literal("providers.changed"),
  providers: z.array(ProviderStatus).max(16),
});
