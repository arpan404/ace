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
  /** Epoch seconds, epoch milliseconds (numbers or numeric strings) or an ISO 8601 string. */
  unit: z.enum(["s", "ms", "iso"]),
});

/** How one window's fields are found, relative to the window's own object. */
export const WindowMapping = z.object({
  /** Where the windows are: a path ending in `*` iterates them; `[]` is the answer itself. */
  each: JsonPath,
  /** A fixed window name ("monthly"), for a single window. */
  label: z.string().min(1).max(64).optional(),
  /** The window's name in the answer; its key in a map when neither is given. */
  name: JsonPath.optional(),
  /** Used share of the window. `remaining` values are converted (100 − x). */
  amount: z.object({
    path: JsonPath,
    scale: z.enum(["percent", "fraction", "remainingPercent", "remainingFraction"]),
  }),
  /** The reset, relative to the window or, with `fromRoot`, to the whole answer. */
  resetsAt: Time.extend({ fromRoot: z.boolean().optional() }).optional(),
  windowDurationMins: JsonPath.optional(),
  /** A fixed window length, when the provider names the window rather than giving its length. */
  durationMins: z.number().int().positive().max(527_040).optional(),
});
export type WindowMapping = z.infer<typeof WindowMapping>;

/** A value the answer must carry to count as a usage report at all. */
const Expect = z.object({ path: JsonPath, equals: z.string().max(128) });

export const UsageMapping = z.object({
  windows: z.array(WindowMapping).max(8).default([]),
  plan: JsonPath.optional(),
  /** An answer missing any of these is no reading, whatever else it carries. */
  expect: z.array(Expect).max(4).default([]),
  /**
   * Whether a full window stops the account's work. Off by default: a meter the provider shows
   * (included spend with bonus beyond it, one model's bucket, one of several providers) is
   * shown but never holds queued messages. Only a provider whose full window refuses all work
   * declares it.
   */
  holds: z.boolean().default(false),
});
export type UsageMapping = z.infer<typeof UsageMapping>;

/** Which account a login belongs to, as its CLI reports it. */
const Identity = z.object({ path: JsonPath });

/** The provider's own CLI prints its usage; ace never sees a credential. */
export const CommandSource = z.object({
  kind: z.literal("command"),
  /** A CLI other than the account's own executable, found on PATH. */
  executable: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
  /** Read-only, prompt-free arguments only. */
  args: z.array(z.string().min(1).max(128)).min(1).max(16),
  timeoutMs: z.number().int().positive().max(60_000).default(20_000),
  /**
   * Where the answer names its login. Set when the CLI answers for its own default login
   * whatever ace's home says: the reading counts only for the account that is that login.
   */
  identity: Identity.optional(),
  mapping: UsageMapping,
});

const Identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/i);
/** Paths relative to the account's CLI home (`~/` for the user's home), tried in order. */
const HomeFiles = z.array(z.string().min(1).max(256)).min(1).max(4);
/** Where the CLI keeps the token it signed in with. */
export const TokenStore = z.discriminatedUnion("from", [
  z.object({ from: z.literal("file"), files: HomeFiles, path: JsonPath, expires: Time.optional() }),
  /** A row of the CLI's own SQLite store, read only. */
  z.object({
    from: z.literal("sqlite"),
    files: HomeFiles,
    table: Identifier,
    keyColumn: Identifier,
    key: z.string().min(1).max(128),
    valueColumn: Identifier,
    path: JsonPath,
    expires: Time.optional(),
  }),
  /** The macOS login keychain item the CLI writes (read with `security`, macOS only). */
  z.object({
    from: z.literal("keychain"),
    service: z.string().min(1).max(128),
    account: z.string().min(1).max(128),
  }),
]);
export type TokenStore = z.infer<typeof TokenStore>;

const Request = z.object({
  method: z.enum(["GET", "POST"]),
  /** HTTPS on the same host the CLI itself uses. */
  url: z.url({ protocol: /^https$/ }),
  /** `Bearer {token}`-style templates; `{token}` is the only placeholder in headers. */
  headers: z.record(z.string().max(64), z.string().max(256)).default({}),
  /** JSON; string values may use `{captured}` from the prelude. */
  body: z.unknown().optional(),
});

/**
 * The CLI's own stored token, read in memory at the moment of the read and sent only to the
 * provider's official usage endpoint (ADR 0002 exception). Never refreshed, stored or logged.
 */
export const TokenSource = z.object({
  kind: z.literal("token-http"),
  /** Where the CLI keeps this store; every platform when absent. */
  platforms: z
    .array(z.enum(["darwin", "linux", "win32"]))
    .min(1)
    .max(3)
    .optional(),
  /** Where the token is: one store, or several tried in order until one holds it. */
  token: z.union([TokenStore, z.array(TokenStore).min(1).max(4)]),
  /**
   * The login the token belongs to, as the account's own CLI reports it (`about --format json`),
   * for a store every home shares (the macOS keychain). The read happens only when it matches the
   * account's known sign-in, or, when that isn't known, when the account is the provider's only
   * one: never another account's limits.
   */
  identity: Identity.extend({ args: z.array(z.string().min(1).max(64)).min(1).max(8) }).optional(),
  /** A first read-only request whose answer supplies `{captured}` (Gemini's project id). */
  prelude: z
    .object({
      request: Request,
      capture: JsonPath,
      /** Where its answer names the plan, tried in order. */
      plan: z.array(JsonPath).min(1).max(4).optional(),
    })
    .optional(),
  request: Request,
  mapping: UsageMapping,
});

export const UsageSource = z.discriminatedUnion("kind", [CommandSource, TokenSource]);
export type UsageSource = z.infer<typeof UsageSource>;

/** A declared source and the CLI to name when its login has to be renewed. */
export interface UsageDeclaration {
  /** "Gemini CLI": in "Sign in again in Gemini CLI". */
  cli: string;
  /** Read in order; their windows and plan combine into one reading. */
  sources: UsageSource[];
}
