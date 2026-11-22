import { readFileSync } from "node:fs";
import { join } from "node:path";
import { grantPublicKey, signCloudGrant } from "@ace/account-grant";
import { machineCredentialStore } from "../account/credentials.ts";
import { sealer } from "../account/crypto.ts";
import { sessionStore } from "../account/sessions.ts";
import { sqliteD1 } from "../testing/sqlite-d1.ts";
import { searchCounters } from "./counters.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import type { SearchLimits } from "./limits.ts";
import { repeatGuard } from "./repeats.ts";
import { searchRoutes } from "./route.ts";

/*
 * ace search's route (ADR 0210) for tests: a real SQLite with the Worker's migrations, a fake
 * Workers AI binding (Cloudflare is never called), live machines made the way the account
 * backend keeps them, and the burst limits read from wrangler.jsonc's production settings.
 */

export const START = Date.UTC(2026, 10, 21, 12, 0, 0);
export const DAY = 86_400_000;
export const HOST_A = "A".repeat(52);
export const HOST_B = "B".repeat(52);
export const host = (n: number) => `H${String(n).padStart(51, "0")}`;
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };

type Asked = { gatewayId: string; query: string; provider?: string; limit?: number };
export type Answer = (asked: Asked) => Response | Promise<Response>;

export const items = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://docs.example/page-${i}`,
    title: `Page ${i}`,
    description: `About page ${i}`,
  }));
export const ok = (body: unknown) => Response.json(body);

/** A production rate limit's `simple.limit` from wrangler.jsonc. */
export function wranglerLimit(name: string): number {
  const text = readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8");
  // JSONC: drop comments outside strings, then trailing commas.
  let json = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      json += char;
      if (char === "\\") json += text[++i];
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      json += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      json += "\n";
    } else json += char;
  }
  const config = JSON.parse(json.replace(/,(\s*[}\]])/g, "$1")) as {
    env: { production: { ratelimits: { name: string; simple: { limit: number } }[] } };
  };
  const found = config.env.production.ratelimits.find((limit) => limit.name === name);
  if (!found) throw new Error(`no ${name} rate limit in production`);
  return found.simple.limit;
}

export function world(
  options: {
    limits?: Partial<SearchLimits>;
    answer?: Answer;
    ai?: false;
    accountBurst?: number;
    gatewaySafe?: () => Promise<boolean>;
    /** `ACE_SEARCH_ENABLED`: false is the kill switch. */
    enabled?: boolean;
  } = {},
) {
  const { db, sqlite, interrupt } = sqliteD1();
  let clock = START;
  const asked: Asked[] = [];
  const logs: string[] = [];
  let answer: Answer = options.answer ?? (() => ok({ items: items(3), metadata: {} }));
  // The bindings' per-minute counts, as Cloudflare keeps them: a count per key per minute.
  const minute = new Map<string, number>();
  const over = (name: string, cap: number) => async (k: string) => {
    const id = `${name}:${k}:${Math.floor(clock / 60_000)}`;
    const next = (minute.get(id) ?? 0) + 1;
    minute.set(id, next);
    return next > cap;
  };
  const routes = searchRoutes({
    keys: { keys: [grantPublicKey(key)] },
    counters: searchCounters(db),
    ai:
      options.ai === false
        ? undefined
        : {
            gatewayId: "ace-search",
            binding: {
              websearch: async (request) => {
                asked.push(request);
                return answer(request);
              },
            },
          },
    gateway: { safe: async () => (options.gatewaySafe ? options.gatewaySafe() : true) },
    enabled: options.enabled ?? true,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    repeats: repeatGuard({ now: () => clock, salt: new Uint8Array(32).fill(1) }),
    now: () => clock,
    addressOf: (request) => request.headers.get("CF-Connecting-IP") ?? "unknown",
    addressSalt: "salt",
    burst: {
      address: over("address", wranglerLimit("SEARCH_ADDRESS_REQUESTS")),
      account: over("account", options.accountBurst ?? wranglerLimit("SEARCH_ACCOUNT_BURST")),
    },
    log: (entry) => logs.push(JSON.stringify(entry)),
  });

  /** A cloud credential for `account` naming `subject`, as /v1/grants signs one. */
  const grant = (account: string, subject: string) =>
    signCloudGrant({ kind: "machine", account, subject, iat: clock, exp: clock + 5 * 60_000 }, key);

  /**
   * `account`'s Spade on machine `hostId`: a live session and the machine credential the daemon
   * exchanged it for (ADR 0190), as the account backend keeps them. Answers a fresh grant.
   */
  const spade = (account = "user_ann", hostId = HOST_A) => {
    const session = `session-${account}-${hostId}`;
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO sessions (token, account, refresh, expires, standing)
         VALUES (?, ?, 'sealed', ?, 'exposed')`,
      )
      .run(
        session,
        JSON.stringify({ id: account, email: `${account}@example.com` }),
        clock + 30 * DAY,
      );
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO machine_credentials (token, session, host_id, account_id, expires, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(`credential-${account}-${hostId}`, session, hostId, account, clock + 30 * DAY, clock);
    return grant(account, hostId);
  };

  const sessions = sessionStore(
    db,
    sealer("ab".repeat(32), (length) => new Uint8Array(length).fill(3)),
    () => "lease",
  );
  const credentials = machineCredentialStore(db);
  /**
   * `ace login` on machine `hostId` (ADR 0190): the session it signed in with is exchanged for a
   * machine credential that becomes its sole holder, and the session's own token is retired, in
   * the batch the exchange route runs. Answers a grant, and the revocation of that credential.
   */
  const soleExchange = async (account: string, hostId: string) => {
    const session = `login-${account}-${hostId}`;
    sqlite
      .prepare(
        "INSERT INTO sessions (token, account, refresh, expires, standing) VALUES (?, ?, 'sealed', ?, 'person')",
      )
      .run(
        session,
        JSON.stringify({ id: account, email: `${account}@example.com` }),
        clock + 30 * DAY,
      );
    const credential = `sole-${account}-${hostId}`;
    await db.batch([
      credentials.inserting(
        credential,
        { session, hostId, accountId: account, expiresAt: clock + 30 * DAY, sole: true },
        clock,
        { session },
      ),
      sessions.retiring(session),
    ]);
    return { grant: () => grant(account, hostId), revoke: () => credentials.remove(credential) };
  };

  const search = (
    body: unknown,
    init: { token?: string; ip?: string; headers?: Record<string, string> } = {},
  ) =>
    routes.search(
      new Request("https://cloud.example/v1/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": init.ip ?? "203.0.113.7",
          ...(init.token === "" ? {} : { Authorization: `Bearer ${init.token ?? spade()}` }),
          ...init.headers,
        },
        body: JSON.stringify(body),
      }),
    );
  const usage = (token = spade()) =>
    routes.usage(
      new Request("https://cloud.example/v1/search/usage", {
        headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": "203.0.113.7" },
      }),
    );
  /** Registers `account`'s first machine at `at`, which makes the account that old. */
  const registered = (account: string, at: number) =>
    sqlite
      .prepare(
        "INSERT INTO machines (host_id, account_id, name, platform, created_at, last_seen_at) VALUES (?, ?, 'mac', 'darwin', ?, ?)",
      )
      .run(`${account}-first`, account, at, at);
  for (const account of ["user_ann", "user_ben", "user_cat"]) registered(account, START - 60 * DAY);
  /** Every counter row, to compare before and after. */
  const counts = () =>
    JSON.stringify(sqlite.prepare("SELECT * FROM search_counts ORDER BY scope, period").all());
  return {
    sqlite,
    asked,
    logs,
    search,
    usage,
    grant,
    spade,
    soleExchange,
    registered,
    counts,
    interrupt,
    answerWith: (next: Answer) => (answer = next),
    advance: (ms: number) => (clock += ms),
    at: () => clock,
  };
}

/** Distinct queries, so the repeat check stays out of a test about counts. */
let n = 0;
export const fresh = () => ({ query: `how do workers bind d1 ${n++}` });

export async function refusal(response: Response) {
  const body = (await response.json()) as { error: string; reason: string; retryAfter: number };
  return {
    status: response.status,
    retryAfterHeader: response.headers.get("Retry-After"),
    ...body,
  };
}

export async function used(response: Response) {
  return ((await response.json()) as { month: { used: number }; day: { used: number } }).month.used;
}
