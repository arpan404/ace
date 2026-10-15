import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { usageDeclaration } from "./builtin.ts";
import { UsageSource, type UsageDeclaration } from "./declaration.ts";
import { readDeclaredUsage, type UsageAccount, type UsagePorts } from "./read.ts";

const secret = "tok_live_3f9a8b7c6d5e4f3a2b1c";
const now = Date.parse("2026-10-15T12:00:00Z");
const homes: string[] = [];
afterEach(async () => {
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-usage-source-"));
  homes.push(dir);
  return dir;
}
async function write(dir: string, file: string, value: unknown) {
  await mkdir(join(dir, file, ".."), { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(value));
}
type Sent = { url: string; init: RequestInit };
function ports(
  respond: (url: string, init: RequestInit) => Response,
  overrides: Partial<UsagePorts> = {},
): { ports: UsagePorts; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    ports: {
      readFile: (path) => readFile(path, "utf8"),
      readSqlite: async () => undefined,
      fetch: async (url, init) => {
        sent.push({ url, init });
        return respond(url, init);
      },
      run: async () => {
        throw new Error("no command here");
      },
      inScratchDir: async (use) => use(await temp()),
      platform: "linux",
      now: () => now,
      ...overrides,
    },
  };
}
const account = (dir: string, extra: Partial<UsageAccount> = {}): UsageAccount => ({
  homeDir: dir,
  env: {},
  executable: "example",
  userHome: dir,
  soleAccount: true,
  baseEnv: {},
  ...extra,
});
const read = (declaration: UsageDeclaration | undefined, who: UsageAccount, io: UsagePorts) => {
  if (!declaration) throw new Error("no declaration");
  return readDeclaredUsage(declaration, who, io, AbortSignal.timeout(5000));
};
const sentBody = (sent: Sent) => JSON.parse(String(sent.init.body)) as unknown;
const header = (sent: Sent, name: string) => new Headers(sent.init.headers).get(name);

/** cursor-agent `about --format json` for its signed-in login (trimmed). */
const cursorAbout = (email: string) =>
  JSON.stringify({ cliVersion: "2026.10.01-e373342", subscriptionTier: "Pro", userEmail: email });
/** A real `GetCurrentPeriodUsage` answer from a Pro login past its included usage (trimmed). */
const cursorUsage = {
  billingCycleStart: "1790259573000",
  billingCycleEnd: "1792851573000",
  planUsage: {
    totalSpend: 9033,
    includedSpend: 2000,
    bonusSpend: 7033,
    limit: 2000,
    autoPercentUsed: 100,
    apiPercentUsed: 64.5,
    totalPercentUsed: 100,
  },
  spendLimitUsage: { limitType: "user" },
  enabled: true,
  displayMessage: "You've hit your usage limit",
};
const cursorPorts = () =>
  ports(() => Response.json(cursorUsage), {
    platform: "darwin",
    run: async ({ executable }) =>
      executable === "/usr/bin/security" ? `${secret}\n` : cursorAbout("me@x.dev"),
  });

test("Cursor reads its plan and included meters, which never hold the account", async () => {
  const io = cursorPorts();
  const result = await read(
    usageDeclaration({ provider: "cursor" }),
    account(await temp(), { signedInAs: "Me@x.dev", soleAccount: false }),
    io.ports,
  );
  const reset = 1792851573000;
  expect(result).toEqual({
    ok: true,
    reading: {
      planType: "Pro",
      usageWindows: {
        included: { usedPercent: 100, resetsAt: reset, advisory: true },
        included_auto: { usedPercent: 100, resetsAt: reset, advisory: true },
        included_api: { usedPercent: 64.5, resetsAt: reset, advisory: true },
      },
    },
  });
  expect(io.sent.map(({ url, init }) => [url, init.method, init.redirect])).toEqual([
    ["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", "POST", "error"],
  ]);
  expect(header(io.sent[0]!, "authorization")).toBe(`Bearer ${secret}`);
  expect(header(io.sent[0]!, "connect-protocol-version")).toBe("1");
});

test("Cursor's shared login is never read for an account it isn't", async () => {
  const io = cursorPorts();
  const result = await read(
    usageDeclaration({ provider: "cursor" }),
    account(await temp(), { signedInAs: "someone-else@x.dev", soleAccount: false }),
    io.ports,
  );
  expect(result).toEqual({ ok: false, reason: "none" });
  expect(io.sent).toEqual([]);
});

/** Gemini CLI's `loadCodeAssist` and `retrieveUserQuota` answers, shaped as its bundle reads them. */
const geminiLoad = {
  currentTier: { id: "standard-tier", name: "Gemini Code Assist" },
  paidTier: { id: "g1-pro-tier", name: "Gemini Code Assist in Google One AI Pro" },
  cloudaicompanionProject: "proud-river-4821",
};
const geminiQuota = {
  buckets: [
    {
      modelId: "gemini-2.5-pro",
      tokenType: "REQUESTS",
      remainingAmount: "120",
      remainingFraction: 0.8,
      resetTime: "2026-10-16T07:00:00Z",
    },
    { modelId: "gemini-2.5-flash", tokenType: "REQUESTS", remainingFraction: 1 },
    { modelId: "gemini-3-pro-preview", tokenType: "REQUESTS" },
  ],
};
const geminiPorts = () =>
  ports((url) => Response.json(url.endsWith(":loadCodeAssist") ? geminiLoad : geminiQuota));

test("Gemini CLI reads each model's quota for the project and tier its login names", async () => {
  const home = await temp();
  await write(home, ".gemini/oauth_creds.json", {
    access_token: secret,
    refresh_token: "1//refresh-never-used",
    expiry_date: now + 30 * 60_000,
  });
  const io = geminiPorts();
  const result = await read(
    usageDeclaration({ provider: "acp", acpAgentId: "official:gemini" }),
    account(home),
    io.ports,
  );
  expect(result).toEqual({
    ok: true,
    reading: {
      planType: "Gemini Code Assist in Google One AI Pro",
      usageWindows: {
        "gemini-2.5-pro": {
          usedPercent: expect.closeTo(20, 6),
          resetsAt: Date.parse("2026-10-16T07:00:00Z"),
          advisory: true,
        },
        "gemini-2.5-flash": { usedPercent: 0, resetsAt: null, advisory: true },
      },
    },
  });
  expect(io.sent.map(({ url }) => url)).toEqual([
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
  ]);
  expect(sentBody(io.sent[1]!)).toEqual({ project: "proud-river-4821" });
});

test("an expired token says sign in again, is never sent, and nothing is written", async () => {
  const home = await temp();
  const credentials = { access_token: secret, refresh_token: "1//r", expiry_date: now - 1 };
  await write(home, ".gemini/oauth_creds.json", credentials);
  const io = geminiPorts();
  const result = await read(
    usageDeclaration({ provider: "acp", acpAgentId: "official:gemini" }),
    account(home),
    io.ports,
  );
  expect(result).toEqual({
    ok: false,
    reason: "signed_out",
    message: "Sign in again in Gemini CLI",
  });
  expect(io.sent).toEqual([]);
  expect(JSON.parse(await readFile(join(home, ".gemini/oauth_creds.json"), "utf8"))).toEqual(
    credentials,
  );
  expect(await readdir(join(home, ".gemini"))).toEqual(["oauth_creds.json"]);
});

test("a rejected token says sign in again", async () => {
  const home = await temp();
  await write(home, ".gemini/oauth_creds.json", { access_token: secret, expiry_date: now + 1 });
  const result = await read(
    usageDeclaration({ provider: "acp", acpAgentId: "official:gemini" }),
    account(home),
    ports(() => new Response("{}", { status: 401 })).ports,
  );
  expect(result).toMatchObject({ ok: false, message: "Sign in again in Gemini CLI" });
});

/** OpenCode Go's `/zen/go/v1/usage` answer, as a signed-in OpenCode 2.0.29 receives it. */
const goUsage = {
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-10-15T19:13:05.690Z" },
    weekly: { status: "ok", percent: 1, resetsAt: "2026-10-19T00:00:00.000Z" },
    monthly: { status: "ok", percent: 0, resetsAt: "2026-11-07T22:57:57.000Z" },
  },
};

test("OpenCode Go's 5-hour, weekly and monthly meters are read with OpenCode's stored key", async () => {
  const home = await temp();
  await write(home, "auth.json", {
    "opencode-go": { type: "api", key: secret },
    lmstudio: { type: "api", key: "lm-other-key" },
  });
  const io = ports(() => Response.json(goUsage));
  const result = await read(usageDeclaration({ provider: "opencode" }), account(home), io.ports);
  expect(result).toEqual({
    ok: true,
    reading: {
      usageWindows: {
        five_hour: {
          usedPercent: 12,
          resetsAt: Date.parse("2026-10-15T19:13:05.690Z"),
          windowDurationMins: 300,
          advisory: true,
        },
        weekly: {
          usedPercent: 1,
          resetsAt: Date.parse("2026-10-19T00:00:00.000Z"),
          windowDurationMins: 10080,
          advisory: true,
        },
        monthly: {
          usedPercent: 0,
          resetsAt: Date.parse("2026-11-07T22:57:57.000Z"),
          advisory: true,
        },
      },
    },
  });
  expect(io.sent.map(({ url, init }) => [url, init.method])).toEqual([
    ["https://opencode.ai/zen/go/v1/usage", "GET"],
  ]);
});

test("an OpenCode login without Go reads nothing and reports nothing", async () => {
  const home = await temp();
  await write(home, "auth.json", { anthropic: { type: "api", key: "sk-ant-not-go" } });
  const io = ports(() => Response.json(goUsage));
  const result = await read(usageDeclaration({ provider: "opencode" }), account(home), io.ports);
  expect(result).toEqual({ ok: false, reason: "none" });
  expect(io.sent).toEqual([]);
});

const example: UsageDeclaration = {
  cli: "Example CLI",
  sources: [
    UsageSource.parse({
      kind: "token-http",
      token: { from: "file", files: ["auth.json"], path: ["access_token"] },
      request: { method: "GET", url: "https://usage.example.com/v1/quota" },
      mapping: { windows: [{ each: ["w", "*"], amount: { path: ["used"], scale: "percent" } }] },
    }),
  ],
};

test.each([
  ["a rejected token", () => new Response(`bad token ${secret}`, { status: 401 })],
  ["a server error echoing it", () => new Response(`upstream saw ${secret}`, { status: 500 })],
  ["an unreadable answer", () => new Response(`{"token":"${secret}"`, { status: 200 })],
])("the token never appears in the result after %s", async (_name, respond) => {
  const home = await temp();
  await write(home, "auth.json", { access_token: secret });
  const result = await read(example, account(home), ports(respond).ports);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("a credential path cannot leave the account's home", async () => {
  const home = await temp();
  await write(home, "../auth.json", { access_token: secret });
  const escaping: UsageDeclaration = {
    cli: "Example CLI",
    sources: [
      UsageSource.parse({
        ...example.sources[0],
        token: { from: "file", files: ["../auth.json"], path: ["access_token"] },
      }),
    ],
  };
  const io = ports(() => Response.json({ w: { day: { used: 1 } } }));
  const result = await read(escaping, account(home), io.ports);
  expect(result.ok).toBe(false);
  expect(io.sent).toEqual([]);
});

const commandReport = (status: string) =>
  JSON.stringify({ status, limits: { daily: { used: 40, resets: 2000 } } });

test("a command source maps the CLI's own JSON usage report", async () => {
  const command: UsageDeclaration = {
    cli: "Example CLI",
    sources: [
      UsageSource.parse({
        kind: "command",
        args: ["usage", "--json"],
        mapping: {
          expect: [{ path: ["status"], equals: "SUCCESS" }],
          holds: true,
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
  const run = async (status: string) =>
    read(command, account(await temp()), {
      ...ports(() => Response.json({})).ports,
      run: async () => commandReport(status),
    });
  expect(await run("SUCCESS")).toEqual({
    ok: true,
    reading: { usageWindows: { daily: { usedPercent: 40, resetsAt: 2_000_000 } } },
  });
  // A report that doesn't say it succeeded is no reading, however it looks.
  expect(await run("PENDING")).toMatchObject({ ok: false, reason: "unavailable" });
});

/** `agy -p /usage --output-format json` from a signed-in Antigravity CLI 1.3.5, as recorded. */
const agyUsage = await readFile(
  new URL("../__fixtures__/antigravity-usage.json", import.meta.url),
  "utf8",
);
const agyReset = Date.parse("2026-10-22T14:55:01Z");
const antigravity = async (stdout: string) =>
  read(
    usageDeclaration({ provider: "acp", acpAgentId: "official:antigravity-acp" }),
    account(await temp()),
    { ...ports(() => Response.json({})).ports, run: async () => stdout },
  );

test("Antigravity's /usage shows each model group's weekly limit, which never holds the account", async () => {
  const weekly = { usedPercent: 0, resetsAt: agyReset, windowDurationMins: 10080, advisory: true };
  // Each group's window names the models it limits, so the two weekly windows read apart.
  const gemini = { ...weekly, limitName: "Gemini Models" };
  const others = { ...weekly, limitName: "Claude and GPT models" };
  expect(await antigravity(agyUsage)).toEqual({
    ok: true,
    reading: {
      usageWindows: { "Gemini Models · weekly": gemini, "Claude and GPT models · weekly": others },
    },
  });
  // A spent group is shown as spent; the other group's models keep working.
  const spent = JSON.parse(agyUsage) as {
    command: { data: { groups: { buckets: { remaining_fraction: number }[] }[] } };
  };
  const [geminiGroup, othersGroup] = spent.command.data.groups;
  if (!geminiGroup?.buckets[0] || !othersGroup?.buckets[0]) throw new Error("fixture changed");
  geminiGroup.buckets[0].remaining_fraction = 0;
  othersGroup.buckets[0].remaining_fraction = 0.25;
  const result = await antigravity(JSON.stringify(spent));
  expect(result.ok && result.reading["usageWindows"]).toEqual({
    "Gemini Models · weekly": { ...gemini, usedPercent: 100 },
    "Claude and GPT models · weekly": { ...others, usedPercent: 75 },
  });
  // An answer that isn't a successful `/usage` report is no reading.
  expect(await antigravity(JSON.stringify({ ...spent, status: "ERROR" }))).toMatchObject({
    ok: false,
    reason: "unavailable",
  });
});
