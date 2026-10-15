import { isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import type { UsageDeclaration, UsageSource } from "./declaration.ts";
import { instant, mapUsage } from "./map.ts";

/*
 * The I/O shell that runs a declared usage source for one account. Everything it can't control
 * is injected. A token read here lives only inside one call: it goes into the declared request's
 * headers to the declared HTTPS host and nowhere else. Errors and results are built from fixed
 * words, never from the token, the credential file or the response, so nothing can leak it.
 */

export interface UsagePorts {
  readFile(path: string): Promise<string>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Runs the account's own CLI and returns its stdout. */
  run(options: {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<string>;
  now(): number;
}

export interface UsageAccount {
  /** The account's CLI home: ace's private one, or the CLI's standard location. */
  homeDir: string;
  env: NodeJS.ProcessEnv;
  executable: string;
}

export type UsageResult =
  | { ok: true; reading: Record<string, unknown> }
  | { ok: false; reason: "signed_out" | "unavailable"; message: string };

const maxBytes = 256 * 1024;
const token = z.string().min(8).max(16_384);

function credentialPath(home: string, file: string): string | undefined {
  if (isAbsolute(file)) return undefined;
  const path = normalize(join(home, file));
  return path.startsWith(normalize(home) + sep) ? path : undefined;
}
function pick(root: unknown, path: readonly (string | number)[]): unknown {
  let value = root;
  for (const step of path) {
    if (typeof value !== "object" || value === null) return undefined;
    const map = z.record(z.string(), z.unknown()).safeParse(value).data;
    const list = z.array(z.unknown()).safeParse(value).data;
    value = typeof step === "number" ? list?.[step] : map?.[step];
  }
  return value;
}
async function bounded(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > maxBytes) throw new Error("too large");
  return JSON.parse(text);
}

async function fromToken(
  source: Extract<UsageSource, { kind: "token-http" }>,
  account: UsageAccount,
  cli: string,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<UsageResult> {
  const signIn = { ok: false, reason: "signed_out", message: `Sign in again in ${cli}` } as const;
  const path = credentialPath(account.homeDir, source.file);
  if (!path) return { ok: false, reason: "unavailable", message: "Usage source is misdeclared" };
  let stored: unknown;
  try {
    const text = await ports.readFile(path);
    if (text.length > maxBytes) return signIn;
    stored = JSON.parse(text);
  } catch {
    return signIn;
  }
  const secret = token.safeParse(pick(stored, source.token)).data;
  if (!secret) return signIn;
  if (source.expires) {
    const at = instant(pick(stored, source.expires.path), source.expires.unit);
    // Never refreshed: ace doesn't write the CLI's credentials. The CLI renews it on its next use.
    if (at !== undefined && at <= ports.now()) return signIn;
  }
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [name, template] of Object.entries(source.request.headers))
    headers[name] = template.replaceAll("{token}", secret);
  if (source.request.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await ports.fetch(source.request.url, {
      method: source.request.method,
      headers,
      ...(source.request.body === undefined ? {} : { body: JSON.stringify(source.request.body) }),
      // The token goes to this host only: a redirect elsewhere is refused, not followed.
      redirect: "error",
      signal,
    });
  } catch {
    return { ok: false, reason: "unavailable", message: `${cli} usage couldn't be reached` };
  }
  if (response.status === 401 || response.status === 403) return signIn;
  if (!response.ok)
    return { ok: false, reason: "unavailable", message: `${cli} usage is unavailable` };
  let answer: unknown;
  try {
    answer = await bounded(response);
  } catch {
    return { ok: false, reason: "unavailable", message: `${cli} sent unreadable usage` };
  }
  const reading = mapUsage(answer, source.mapping);
  return reading
    ? { ok: true, reading: { auth: "logged_in", ...reading } }
    : { ok: false, reason: "unavailable", message: `${cli} reported no usage windows` };
}

async function fromCommand(
  source: Extract<UsageSource, { kind: "command" }>,
  account: UsageAccount,
  cli: string,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<UsageResult> {
  let answer: unknown;
  try {
    const stdout = await ports.run({
      executable: account.executable,
      args: source.args,
      env: account.env,
      cwd: account.homeDir,
      timeoutMs: source.timeoutMs,
      signal,
    });
    if (stdout.length > maxBytes) throw new Error("too large");
    answer = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "unavailable", message: `${cli} usage is unavailable` };
  }
  const reading = mapUsage(answer, source.mapping);
  return reading
    ? { ok: true, reading: { auth: "logged_in", ...reading } }
    : { ok: false, reason: "unavailable", message: `${cli} reported no usage windows` };
}

/** Tries each declared source in order and returns the first reading, else the last failure. */
export async function readDeclaredUsage(
  declaration: UsageDeclaration,
  account: UsageAccount,
  ports: UsagePorts,
  signal: AbortSignal,
): Promise<UsageResult> {
  let last: UsageResult = {
    ok: false,
    reason: "unavailable",
    message: `${declaration.cli} has no usage source`,
  };
  for (const source of declaration.sources) {
    signal.throwIfAborted();
    last =
      source.kind === "command"
        ? await fromCommand(source, account, declaration.cli, ports, signal)
        : await fromToken(source, account, declaration.cli, ports, signal);
    if (last.ok) return last;
  }
  return last;
}
