import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { UsageSource, type UsageDeclaration } from "./declaration.ts";
import { readDeclaredUsage, type UsagePorts } from "./read.ts";

const secret = "tok_live_3f9a8b7c6d5e4f3a2b1c";
const now = Date.parse("2026-10-15T12:00:00Z");
const homes: string[] = [];
afterEach(async () => {
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function home(credentials: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-usage-source-"));
  homes.push(dir);
  await writeFile(join(dir, "auth.json"), JSON.stringify(credentials));
  return dir;
}
const declaration: UsageDeclaration = {
  cli: "Example CLI",
  sources: [
    UsageSource.parse({
      kind: "token-http",
      file: "auth.json",
      token: ["oauth", "access_token"],
      expires: { path: ["oauth", "expiry_date"], unit: "ms" },
      request: {
        method: "POST",
        url: "https://usage.example.com/v1/quota",
        headers: { authorization: "Bearer {token}" },
        body: {},
      },
      mapping: {
        windows: [
          {
            each: ["buckets", "*"],
            name: ["modelId"],
            amount: { path: ["remainingFraction"], scale: "remainingFraction" },
            resetsAt: { path: ["resetTime"], unit: "iso" },
          },
        ],
        plan: ["tier"],
      },
    }),
  ],
};
const answer = {
  tier: "pro",
  buckets: [
    { modelId: "fast", remainingFraction: 0.25, resetTime: "2026-10-15T18:00:00Z" },
    { modelId: "deep", remainingFraction: "oops" },
  ],
};
function ports(respond: (url: string, init: RequestInit) => Response): {
  ports: UsagePorts;
  sent: { url: string; init: RequestInit }[];
} {
  const sent: { url: string; init: RequestInit }[] = [];
  return {
    sent,
    ports: {
      readFile: (path) => readFile(path, "utf8"),
      fetch: async (url, init) => {
        sent.push({ url, init });
        return respond(url, init);
      },
      run: async () => {
        throw new Error("no command source");
      },
      now: () => now,
    },
  };
}
const account = (dir: string) => ({ homeDir: dir, env: {}, executable: "example" });

test("a token source reads windows, resets and plan from the provider's own usage endpoint", async () => {
  const dir = await home({ oauth: { access_token: secret, expiry_date: now + 60_000 } });
  const io = ports(() => Response.json(answer));
  const result = await readDeclaredUsage(
    declaration,
    account(dir),
    io.ports,
    AbortSignal.timeout(5000),
  );
  expect(result).toEqual({
    ok: true,
    reading: {
      auth: "logged_in",
      usageWindows: { fast: { usedPercent: 75, resetsAt: Date.parse("2026-10-15T18:00:00Z") } },
      planType: "pro",
    },
  });
  // Only to the declared host, never following a redirect elsewhere.
  expect(io.sent.map((request) => [request.url, request.init.redirect])).toEqual([
    ["https://usage.example.com/v1/quota", "error"],
  ]);
});

test("an expired token reports sign in again and is never sent or refreshed", async () => {
  const credentials = { oauth: { access_token: secret, expiry_date: now - 1 } };
  const dir = await home(credentials);
  const io = ports(() => Response.json(answer));
  const result = await readDeclaredUsage(
    declaration,
    account(dir),
    io.ports,
    AbortSignal.timeout(5000),
  );
  expect(result).toEqual({
    ok: false,
    reason: "signed_out",
    message: "Sign in again in Example CLI",
  });
  expect(io.sent).toEqual([]);
  // ace never writes the CLI's credentials.
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))).toEqual(credentials);
});

test.each([
  ["a rejected token", () => new Response(`bad token ${secret}`, { status: 401 })],
  ["a server error echoing it", () => new Response(`upstream saw ${secret}`, { status: 500 })],
  ["an unreadable answer", () => new Response(`{"token":"${secret}"`, { status: 200 })],
])("the token never appears in the result after %s", async (_name, respond) => {
  const dir = await home({ oauth: { access_token: secret, expiry_date: now + 60_000 } });
  const result = await readDeclaredUsage(
    declaration,
    account(dir),
    ports(respond).ports,
    AbortSignal.timeout(5000),
  );
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("a credential path cannot leave the account's home", async () => {
  const dir = await home({});
  const escaping: UsageDeclaration = {
    cli: "Example CLI",
    sources: [{ ...declaration.sources[0], file: "../../etc/passwd" } as UsageSource],
  };
  const io = ports(() => Response.json(answer));
  const result = await readDeclaredUsage(
    escaping,
    account(dir),
    io.ports,
    AbortSignal.timeout(5000),
  );
  expect(result.ok).toBe(false);
  expect(io.sent).toEqual([]);
});

test("a command source maps the CLI's own JSON usage report", async () => {
  const command: UsageDeclaration = {
    cli: "Example CLI",
    sources: [
      UsageSource.parse({
        kind: "command",
        args: ["usage", "--json"],
        mapping: {
          windows: [
            {
              each: ["limits", "*"],
              amount: { path: ["used"], scale: "percent" },
              resetsAt: { path: ["resets"], unit: "s" },
            },
          ],
        },
      }),
    ],
  };
  const result = await readDeclaredUsage(
    command,
    account(await home({})),
    {
      ...ports(() => Response.json({})).ports,
      run: async ({ args }) =>
        JSON.stringify({ limits: { daily: { used: 40, resets: args.length * 1000 } } }),
    },
    AbortSignal.timeout(5000),
  );
  expect(result).toEqual({
    ok: true,
    reading: {
      auth: "logged_in",
      usageWindows: { daily: { usedPercent: 40, resetsAt: 2_000_000 } },
    },
  });
});
