import { z } from "zod";

/*
 * A usage source, declared as data: how to read an account's plan limits without a model turn
 * and how its answer maps to windows. A provider or ACP agent gets usage by adding one of these
 * to ace's shipped table, never by new reader code. Declarations ship with ace only: a remote
 * registry cannot declare one, since a source runs a command or reads a credential.
 */

/** A step into JSON: a key, an index, or `*` for every entry of a list or map. */
const Step = z.union([z.string().min(1).max(64), z.number().int().nonnegative().max(1024)]);
export const JsonPath = z.array(Step).max(12);
export type JsonPath = z.infer<typeof JsonPath>;

const Time = z.object({
  path: JsonPath,
  /** Epoch seconds, epoch milliseconds or an ISO 8601 string. */
  unit: z.enum(["s", "ms", "iso"]),
});

/** How one window's fields are found, relative to the window's own object. */
export const WindowMapping = z.object({
  /** Where the windows are: a path ending in `*` iterates them. */
  each: JsonPath,
  /** The window's name; its key in a map when absent. */
  name: JsonPath.optional(),
  /** Used share of the window. `remaining` values are converted (100 − x). */
  amount: z.object({
    path: JsonPath,
    scale: z.enum(["percent", "fraction", "remainingPercent", "remainingFraction"]),
  }),
  resetsAt: Time.optional(),
  windowDurationMins: JsonPath.optional(),
});
export type WindowMapping = z.infer<typeof WindowMapping>;

export const UsageMapping = z.object({
  windows: z.array(WindowMapping).min(1).max(8),
  plan: JsonPath.optional(),
});
export type UsageMapping = z.infer<typeof UsageMapping>;

/** The provider's own CLI prints its usage; ace never sees a credential. */
export const CommandSource = z.object({
  kind: z.literal("command"),
  /** Arguments to the account's own CLI executable. Read-only, prompt-free commands only. */
  args: z.array(z.string().min(1).max(128)).min(1).max(16),
  timeoutMs: z.number().int().positive().max(60_000).default(20_000),
  mapping: UsageMapping,
});

/**
 * The CLI's own stored token, read in memory at the moment of the read and sent only to the
 * provider's official usage endpoint (ADR 0002 exception). Never refreshed, stored or logged.
 */
export const TokenSource = z.object({
  kind: z.literal("token-http"),
  /** The credential file, relative to the account's CLI home. */
  file: z.string().min(1).max(256),
  token: JsonPath,
  /** When the token stops working; an expired one reports "sign in again". */
  expires: Time.optional(),
  request: z.object({
    method: z.enum(["GET", "POST"]),
    /** HTTPS on the same host the CLI itself uses. */
    url: z.url({ protocol: /^https$/ }),
    /** `Bearer {token}`-style templates; `{token}` is the only placeholder. */
    headers: z.record(z.string().max(64), z.string().max(256)).default({}),
    body: z.unknown().optional(),
  }),
  mapping: UsageMapping,
});

export const UsageSource = z.discriminatedUnion("kind", [CommandSource, TokenSource]);
export type UsageSource = z.infer<typeof UsageSource>;

/** A declared source and the CLI to name when its login has to be renewed. */
export interface UsageDeclaration {
  /** "Gemini CLI": in "Sign in again in Gemini CLI". */
  cli: string;
  sources: UsageSource[];
}
