import { isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import type { TokenStore, UsageDeclaration, UsageSource } from "./declaration.ts";
import { first, instant, mapUsage, planName, type UsageReading } from "./map.ts";

/*
 * The I/O shell that runs a declared usage source for one account. Everything it can't control
 * is injected. A token read here lives only inside one call: it goes into the declared request's
 * headers to the declared HTTPS host and nowhere else. Errors and results are built from fixed
 * words, never from the token, the credential store or the response, so nothing can leak it.
 */

export interface UsagePorts {
  /** A small file's text; rejects when it is missing, unreadable or too large. */
  readFile(path: string): Promise<string>;
  /** One value from a SQLite file opened read-only; undefined when there is none. */
  readSqlite(options: {
    path: string;
    table: string;
    keyColumn: string;
    key: string;
    valueColumn: string;
  }): Promise<string | undefined>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /**
   * Runs a CLI with no input and returns its stdout. Rejects with a `UsageRunError`: `missing`
   * when the executable isn't there, `signed_out` when its output holds any `signedOut` words.
   */
  run(options: {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    signedOut?: string[];
  }): Promise<string>;
  /** Runs `use` in a fresh empty directory, removed afterwards. */
  inScratchDir<T>(use: (dir: string) => Promise<T>): Promise<T>;
  platform: NodeJS.Platform;
  now(): number;
}

/** Why a usage command gave no answer; it never carries the command's output. */
export class UsageRunError extends Error {
  readonly kind: "missing" | "signed_out" | "failed";
  constructor(kind: "missing" | "signed_out" | "failed") {
    super("Usage command failed");
    this.kind = kind;
  }
}

export interface UsageAccount {
  /** The account's CLI home: ace's private one, or the CLI's standard location. */
  homeDir: string;
  /** The account's own environment, its home selected. */
  env: NodeJS.ProcessEnv;
  /** The account's own CLI; empty when it has none ace can run. */
  executable: string;
  /** The user's home, for credentials a CLI keeps there whatever its home (`~/`). */
  userHome: string;
  /** Who ace knows the account is signed in as, when it does. */
  signedInAs?: string | undefined;
  /** The account is the only one of its provider, so a CLI login can only be its. */
  soleAccount: boolean;
  /** The user's normal environment, where the CLI's own default login answers. */
  baseEnv: NodeJS.ProcessEnv;
}

export type UsageFailure = { ok: false; reason: "signed_out" | "unavailable"; message: string };
/** No declared source applies to this account: no stored login, no matching identity. */
export type NoUsage = { ok: false; reason: "none" };
export type UsageResult =
  | {
      ok: true;
      reading: Record<string, unknown>;
      /** A source that couldn't answer because its login needs renewing, beside one that did. */
      notice?: string;
    }
  | UsageFailure
  | NoUsage;
type Attempt = { ok: true; reading: UsageReading } | UsageFailure | undefined;

const maxBytes = 256 * 1024;
const secretShape = z.string().min(8).max(16_384);
const login = z.string().trim().min(1).max(256);

function inHome(home: string, file: string): string | undefined {
  if (!isAbsolute(home) || isAbsolute(file)) return undefined;
  const path = normalize(join(home, file));
  return path.startsWith(normalize(home) + sep) ? path : undefined;
}
/** XDG's config home in the user's own environment: `$XDG_CONFIG_HOME` if absolute, else `~/.config`. */
function configHome(account: UsageAccount): string {
  const configured = account.baseEnv.XDG_CONFIG_HOME;
  return configured && isAbsolute(configured) ? configured : join(account.userHome, ".config");
}
/** A declared credential file: under the user's home (`~/`), XDG config home, or the CLI home. */
function homeFile(account: UsageAccount, file: string): string | undefined {
  if (file.startsWith("~/")) return inHome(account.userHome, file.slice(2));
  if (file.startsWith(xdgConfig)) return inHome(configHome(account), file.slice(xdgConfig.length));
  if (process.platform === "win32" && file.startsWith(appData))
    return inHome(appDataHome(account), file.slice(appData.length));
  return inHome(account.homeDir, file);
}
const xdgConfig = "$XDG_CONFIG_HOME/";
/** Windows' roaming app data in the user's own environment: `%APPDATA%` if absolute, else `~\AppData\Roaming`. */
function appDataHome(account: UsageAccount): string {
  const configured = account.baseEnv.APPDATA;
  return configured && isAbsolute(configured)
    ? configured
    : join(account.userHome, "AppData", "Roaming");
}
const appData = "$APPDATA/";
/** `{captured}` in the body's string values, for a prelude's answer; nothing else. */
function fill(value: unknown, captured: string | undefined): unknown {
  if (typeof value === "string")
    return captured === undefined ? value : value.replaceAll("{captured}", captured);
  if (Array.isArray(value)) return value.map((entry) => fill(entry, captured));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, captured)]));
  return value;
}
/** A login the CLI reported is this account's: its known sign-in, or its provider's only one. */
function sameLogin(reported: unknown, account: UsageAccount): boolean {
  const who = login.safeParse(reported).data;
  if (!who) return false;
  const known = login.safeParse(account.signedInAs).data;
  return known ? known.toLowerCase() === who.toLowerCase() : account.soleAccount;
}

type TokenSource = Extract<UsageSource, { kind: "token-http" }>;
/** A token, or why there is none: no login here, one that has lapsed, or a store ace can't use. */
type Stored = { secret: string } | { failure: "missing" | "expired" | "unavailable" };

async function fromKeychain(
  store: Extract<TokenStore, { from: "keychain" }>,
  account: UsageAccount,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<Stored> {
  if (ports.platform !== "darwin") return { failure: "unavailable" };
  try {
    const out = await ports.run({
      executable: "/usr/bin/security",
      args: ["find-generic-password", "-s", store.service, "-a", store.account, "-w"],
      env: {},
      cwd: account.homeDir,
      timeoutMs: 5000,
      signal,
    });
    const secret = secretShape.safeParse(out.trim()).data;
    return secret ? { secret } : { failure: "missing" };
  } catch {
    return { failure: "missing" };
  }
}

async function fromStore(
  store: TokenStore,
  account: UsageAccount,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<Stored> {
  if (store.from === "keychain") return fromKeychain(store, account, ports, signal);
  for (const file of store.files) {
    const path = homeFile(account, file);
    if (!path) return { failure: "unavailable" };
    let value: unknown;
    try {
      const text =
        store.from === "file"
          ? await ports.readFile(path)
          : await ports.readSqlite({
              path,
              table: store.table,
              keyColumn: store.keyColumn,
              key: store.key,
              valueColumn: store.valueColumn,
            });
      if (text === undefined || text.length > maxBytes) continue;
      value = JSON.parse(text);
    } catch {
      continue;
    }
    const secret = secretShape.safeParse(first(value, store.path)).data;
    if (!secret) continue;
    if (store.expires) {
      const at = instant(first(value, store.expires.path), store.expires.unit);
      // Never refreshed: ace doesn't write the CLI's credentials; the CLI renews on next use.
      if (at !== undefined && at <= ports.now()) return { failure: "expired" };
    }
    return { secret };
  }
  return { failure: "missing" };
}

/** The first store that holds a token; a lapsed or unusable one ends the search. */
async function stored(
  token: TokenSource["token"],
  account: UsageAccount,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<Stored> {
  for (const store of Array.isArray(token) ? token : [token]) {
    const found = await fromStore(store, account, ports, signal);
    if (!("failure" in found) || found.failure !== "missing") return found;
  }
  return { failure: "missing" };
}

async function call(
  request: TokenSource["request"],
  secret: string,
  captured: string | undefined,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<{ status: number; answer?: unknown }> {
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [name, template] of Object.entries(request.headers))
    headers[name] = template.replaceAll("{token}", secret);
  if (request.body !== undefined) headers["content-type"] = "application/json";
  const response = await ports.fetch(request.url, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(fill(request.body, captured)) }),
    // The token goes to this host only: a redirect elsewhere is refused, not followed.
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { status: response.status };
  }
  const text = await response.text();
  if (text.length > maxBytes) return { status: 502 };
  return { status: response.status, answer: JSON.parse(text) };
}

/** Whether the login a shared store holds is this account's, asked of the account's own CLI. */
async function ownsSharedLogin(
  identity: NonNullable<TokenSource["identity"]>,
  account: UsageAccount,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<boolean> {
  if (!account.executable) return false;
  try {
    const out = await ports.run({
      executable: account.executable,
      args: identity.args,
      env: account.baseEnv,
      cwd: account.homeDir,
      timeoutMs: 10_000,
      signal,
    });
    if (out.length > maxBytes) return false;
    return sameLogin(first(JSON.parse(out), identity.path), account);
  } catch {
    return false;
  }
}

async function fromToken(
  source: TokenSource,
  account: UsageAccount,
  cli: string,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<Attempt> {
  if (source.platforms && !source.platforms.some((platform) => platform === ports.platform))
    return undefined;
  if (source.identity && !(await ownsSharedLogin(source.identity, account, ports, signal)))
    return undefined;
  const signIn: UsageFailure = {
    ok: false,
    reason: "signed_out",
    message: `Sign in again in ${cli}`,
  };
  const unavailable = (words: string): UsageFailure => ({
    ok: false,
    reason: "unavailable",
    message: `${cli} ${words}`,
  });
  const token = await stored(source.token, account, ports, signal);
  // No stored login is no reading (another sign-in method, or no plan with usage), not an error.
  if ("failure" in token)
    return token.failure === "missing"
      ? undefined
      : token.failure === "expired"
        ? signIn
        : unavailable("usage is unavailable");
  try {
    let captured: string | undefined;
    let plan = "";
    if (source.prelude) {
      const prelude = await call(source.prelude.request, token.secret, undefined, ports, signal);
      if (prelude.status === 401) return signIn;
      captured = z
        .string()
        .min(1)
        .max(256)
        .safeParse(first(prelude.answer, source.prelude.capture)).data;
      if (!captured) return unavailable("usage is unavailable");
      for (const path of source.prelude.plan ?? []) plan ||= planName(first(prelude.answer, path));
    }
    const result = await call(source.request, token.secret, captured, ports, signal);
    if (result.status === 401) return signIn;
    if (result.answer === undefined) return unavailable("usage is unavailable");
    const reading = mapUsage(result.answer, source.mapping);
    if (!reading) return unavailable("reported no usage");
    return {
      ok: true,
      reading: plan && !reading.planType ? { ...reading, planType: plan } : reading,
    };
  } catch {
    return unavailable("usage couldn't be reached");
  }
}

async function fromCommand(
  source: Extract<UsageSource, { kind: "command" }>,
  account: UsageAccount,
  cli: string,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<Attempt> {
  const executable = source.executable ?? account.executable;
  if (!executable) return undefined;
  let answer: unknown;
  try {
    const run = (cwd: string) =>
      ports.run({
        executable,
        args: source.args,
        env: account.env,
        cwd,
        timeoutMs: source.timeoutMs,
        signal,
        ...(source.signedOut.length ? { signedOut: source.signedOut } : {}),
      });
    const stdout = await (source.scratchCwd ? ports.inScratchDir(run) : run(account.homeDir));
    if (stdout.length > maxBytes) throw new Error("too large");
    answer = JSON.parse(stdout);
  } catch (error) {
    // A CLI that isn't installed has no usage to show; a lapsed login is reported, not retried.
    if (error instanceof UsageRunError && error.kind === "missing") return undefined;
    if (error instanceof UsageRunError && error.kind === "signed_out")
      return { ok: false, reason: "signed_out", message: `Sign in again in ${cli}` };
    return { ok: false, reason: "unavailable", message: `${cli} usage is unavailable` };
  }
  // The CLI answered for its own login, which may be another account's.
  if (source.identity && !sameLogin(first(answer, source.identity.path), account)) return undefined;
  const reading = mapUsage(answer, source.mapping);
  return reading
    ? { ok: true, reading }
    : { ok: false, reason: "unavailable", message: `${cli} reported no usage` };
}

/**
 * Reads every declared source and combines their windows and plan into one reading. Ok when any
 * source answered; otherwise the most telling failure (a sign-in problem over the rest).
 */
export async function readDeclaredUsage(
  declaration: UsageDeclaration,
  account: UsageAccount,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<UsageResult> {
  const windows: Record<string, unknown> = {};
  let plan: string | undefined;
  let answered = false;
  let failure: UsageFailure | undefined;
  for (const source of declaration.sources) {
    signal.throwIfAborted();
    const attempt =
      source.kind === "command"
        ? await fromCommand(source, account, declaration.cli, ports, signal)
        : await fromToken(source, account, declaration.cli, ports, signal);
    if (!attempt) continue;
    if (attempt.ok) {
      answered = true;
      Object.assign(windows, attempt.reading.usageWindows ?? {});
      plan ??= attempt.reading.planType;
    } else if (!failure || attempt.reason === "signed_out") failure = attempt;
  }
  if (!answered) return failure ?? { ok: false, reason: "none" };
  return {
    ok: true,
    // No `auth`: a usage read never changes what ace knows about the login.
    reading: {
      ...(Object.keys(windows).length ? { usageWindows: windows } : {}),
      ...(plan ? { planType: plan } : {}),
    },
    ...(failure?.reason === "signed_out" ? { notice: failure.message } : {}),
  };
}
