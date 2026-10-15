import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  antigravityIdentity,
  createAcpInstance,
  createAntigravityInstance,
  openRegistry,
  usageDeclaration,
  UsageSource,
  type UsageDeclaration,
} from "@ace/accounts";
import { availability } from "@ace/accounts/availability";
import { AcpIdentity } from "@ace/protocol";
import { defaultUsagePorts, refreshDeclaredLimits } from "./declared-limits.ts";
import { harness } from "./account-management-test-support.ts";

const secret = "sk-go-never-leaves-the-read-7f3c91d2";
const now = () => Date.parse("2026-10-15T12:00:00Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A local stand-in for a provider's usage endpoint. It answers only a request carrying the
 * expected token, and echoes whatever it was sent in its errors, as a careless upstream would.
 */
async function endpoint(answers: Record<string, unknown>) {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    const authorization = request.headers.authorization;
    seen.push({ path, authorization });
    const answer = answers[path];
    if (authorization !== `Bearer ${secret}` || answer === undefined) {
      response.writeHead(401).end(`rejected ${authorization ?? ""}`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.close();
    await once(server, "close");
  });
  return { base, seen };
}
/** The real ports, with the provider's HTTPS host pointed at the local endpoint. */
function portsTo(base: string, host: string, clock: () => number) {
  const real = defaultUsagePorts(clock);
  return {
    ...real,
    fetch: (url: string, init: RequestInit) => real.fetch(url.replace(host, base), init),
  };
}

/** OpenCode Go's `/zen/go/v1/usage`, as a signed-in OpenCode 2.0.29 receives it. */
const goUsage = (percent: number) => ({
  usage: {
    rolling: { status: "ok", percent, resetsAt: "2099-10-15T19:13:05.690Z" },
    weekly: { status: "ok", percent: 1, resetsAt: "2099-10-19T00:00:00.000Z" },
    monthly: { status: "ok", percent: 0, resetsAt: "2099-11-07T22:57:57.000Z" },
  },
});

test("OpenCode Go usage reaches the accounts list over the socket, and its key never leaves the read", async () => {
  const { base, seen } = await endpoint({ "/zen/go/v1/usage": goUsage(100) });
  const logs: string[] = [];
  const f = await harness(false, {
    usagePorts: portsTo(base, "https://opencode.ai", () => 100),
    limitsError: (instance, error) => logs.push(`${instance} ${String(error)}`),
  });
  cleanups.push(() => f.close());
  // OpenCode v2 keeps the Go key in its SQLite credential table in its normal CLI home.
  const home = f.registry.get("opencode-cli-default")?.instance.homeDir;
  if (!home) throw new Error("no implicit OpenCode account");
  await mkdir(home, { recursive: true });
  // The implicit home outlives this harness: the key must not reach a later test's real read.
  cleanups.push(() => rm(join(home, "opencode.db"), { force: true }));
  const db = new DatabaseSync(join(home, "opencode.db"));
  db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT)");
  db.prepare("INSERT INTO credential VALUES (?, ?, ?)").run(
    "c1",
    "opencode-go",
    JSON.stringify({ type: "api", key: secret }),
  );
  db.close();
  const before = await stat(join(home, "opencode.db"));

  const wire: string[] = [];
  f.owner.socket.on("message", (data) => wire.push(String(data)));
  const reply = await f.request(f.owner, { type: "accounts.refreshLimits", requestId: f.rid() });
  if (reply.type !== "accounts.list") throw new Error(JSON.stringify(reply));
  const opencode = reply.accounts.find((account) => account.id === "opencode-cli-default");
  expect(opencode?.quota.windows).toMatchObject({
    five_hour: { usedPercent: 100, windowDurationMins: 300, advisory: true },
    weekly: { usedPercent: 1, advisory: true },
    monthly: { usedPercent: 0, advisory: true },
  });
  // A full Go meter is shown, but OpenCode's other providers still work: nothing is held.
  expect(opencode?.availability).not.toBe("exhausted");
  expect(seen).toEqual([{ path: "/zen/go/v1/usage", authorization: `Bearer ${secret}` }]);

  // Nothing ace keeps, logs or sends carries the key, and its store is left as it was.
  expect(wire.length).toBeGreaterThan(0);
  expect(wire.join("\n")).not.toContain(secret);
  expect(logs.join("\n")).not.toContain(secret);
  expect(await readFile(join(f.dataDir, "accounts.sqlite"))).not.toContain(Buffer.from(secret));
  expect(JSON.stringify(f.store.readEvents({ afterSeq: 0, limit: 10000 }))).not.toContain(secret);
  expect((await stat(join(home, "opencode.db"))).mtimeMs).toBe(before.mtimeMs);
});

const gemini = AcpIdentity.parse({
  acpAgentId: "official:gemini",
  installationId: "installed-gemini",
  instanceId: "installed-gemini:default",
});
async function registryWith(...identities: AcpIdentity[]) {
  const root = await mkdtemp(join(tmpdir(), "ace-declared-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  cleanups.push(async () => {
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  const userHome = join(root, "user");
  await mkdir(userHome);
  for (const identity of identities)
    await registry.register(createAcpInstance({ identity, label: "Agent", userHome }));
  return { registry, root, userHome };
}

test("an expired Gemini login shows sign in again, sends nothing and writes nothing", async () => {
  const { registry, root, userHome } = await registryWith(gemini);
  const { base, seen } = await endpoint({});
  await mkdir(join(userHome, ".gemini"));
  const credentials = JSON.stringify({
    access_token: secret,
    refresh_token: "1//never-used",
    expiry_date: Date.parse("2026-10-15T11:00:00Z"),
  });
  await writeFile(join(userHome, ".gemini", "oauth_creds.json"), credentials);
  const listing = async () =>
    Promise.all(
      (await readdir(userHome, { recursive: true })).map(async (name) => [
        name,
        (await stat(join(userHome, name))).mtimeMs,
      ]),
    );
  const before = await listing();
  const logs: string[] = [];
  await refreshDeclaredLimits({
    registry,
    declaration: usageDeclaration,
    executable: () => undefined,
    env: { HOME: userHome },
    userHome,
    ports: portsTo(base, "https://cloudcode-pa.googleapis.com", now),
    now,
    signal: AbortSignal.timeout(10_000),
    onError: (instance, message) => logs.push(`${instance}: ${message}`),
  });
  const account = registry.summary(gemini.instanceId, now());
  expect(account?.quota.usageNotice).toEqual({
    reason: "signed_out",
    message: "Sign in again in Gemini CLI",
    observedAt: now(),
  });
  expect(account?.quota.windows).toEqual({});
  expect(account && availability(account.quota, now())).not.toBe("exhausted");
  expect(seen).toEqual([]);
  expect(await listing()).toEqual(before);
  expect(await readFile(join(userHome, ".gemini", "oauth_creds.json"), "utf8")).toBe(credentials);
  expect(logs).toEqual([`${gemini.instanceId}: Sign in again in Gemini CLI`]);
  expect(await readFile(join(root, "accounts.sqlite"))).not.toContain(Buffer.from(secret));
});

test("an ACP agent declared as data gets usage with no adapter code", async () => {
  const agent = AcpIdentity.parse({
    acpAgentId: "local:quota-agent",
    installationId: "installed-quota-agent",
    instanceId: "installed-quota-agent:default",
  });
  const { registry, root, userHome } = await registryWith(agent);
  // The agent's own CLI prints its usage as JSON; the declaration says where everything is.
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "quota-agent"),
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2).join(" ") === "usage --json" ? {plan:"Team",limits:[{id:"daily",left:0.25,resets:"2099-01-02T00:00:00Z"}]} : {}));\n`,
    { mode: 0o700 },
  );
  const declared: UsageDeclaration = {
    cli: "Quota Agent",
    sources: [
      UsageSource.parse(
        JSON.parse(
          JSON.stringify({
            kind: "command",
            executable: "quota-agent",
            args: ["usage", "--json"],
            mapping: {
              plan: ["plan"],
              holds: true,
              windows: [
                {
                  each: ["limits", "*"],
                  name: ["id"],
                  amount: { path: ["left"], scale: "remainingFraction" },
                  resetsAt: { path: ["resets"], unit: "iso" },
                  durationMins: 1440,
                },
              ],
            },
          }),
        ),
      ),
    ],
  };
  await refreshDeclaredLimits({
    registry,
    declaration: (instance) => (instance.acpAgentId === agent.acpAgentId ? declared : undefined),
    executable: () => undefined,
    env: { HOME: userHome, PATH: bin },
    userHome,
    ports: defaultUsagePorts(now),
    now,
    signal: AbortSignal.timeout(10_000),
  });
  expect(registry.summary(agent.instanceId, now())?.quota).toMatchObject({
    plan: "Team",
    windows: {
      daily: {
        usedPercent: 75,
        resetsAt: Date.parse("2099-01-02T00:00:00Z"),
        windowDurationMins: 1440,
      },
    },
  });
});

/** `agy -p /usage --output-format json` from a signed-in Antigravity CLI 1.3.5, as recorded. */
const agyUsage = new URL(
  "../../../packages/accounts/src/__fixtures__/antigravity-usage.json",
  import.meta.url,
);
/**
 * A stand-in `agy` on the harness PATH that logs each run. Signed in, it prints the recorded
 * `/usage` answer. Signed out it behaves as the real one could: with its input closed it says so
 * and exits; given an open input it asks for a sign-in and opens a browser to do it.
 */
async function fakeAgy(f: Awaited<ReturnType<typeof harness>>, signedIn: boolean) {
  const runs = join(f.root, "agy-runs.jsonl");
  const opened = join(f.root, "browser-opened");
  await writeFile(
    join(f.bin, "open"),
    `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(opened)}, process.argv.slice(2).join(" "));\n`,
    { mode: 0o700 },
  );
  const usage = await readFile(agyUsage, "utf8");
  await writeFile(
    join(f.bin, "agy"),
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME }) + "\\n");
if (args.join(" ") !== "-p /usage --output-format json") process.exit(2);
if (${signedIn}) { process.stdout.write(${JSON.stringify(usage)}); process.exit(0); }
const prompt = setTimeout(() => {
  console.log("Welcome back! You are currently not signed in. Opening your browser to sign in...");
  require("child_process").execFileSync("open", ["https://accounts.google.com/o/oauth2/auth"]);
  process.exit(1);
}, 300);
process.stdin.on("end", () => {
  clearTimeout(prompt);
  console.error("Error: authentication required. Run 'agy' to log in, then retry.");
  process.exit(1);
});
process.stdin.resume();
`,
    { mode: 0o700 },
  );
  const log = async () =>
    (await readFile(runs, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; home: string });
  const browserOpened = () =>
    stat(opened).then(
      () => true,
      () => false,
    );
  return { log, browserOpened };
}
async function antigravityHarness() {
  const logs: string[] = [];
  const f = await harness(false, {
    limitsError: (instance, error) => logs.push(`${instance}: ${String(error)}`),
  });
  cleanups.push(() => f.close());
  await f.registry.register(createAntigravityInstance(f.normalHome));
  const refresh = async () => {
    const reply = await f.request(f.owner, { type: "accounts.refreshLimits", requestId: f.rid() });
    if (reply.type !== "accounts.list") throw new Error(JSON.stringify(reply));
    return reply.accounts.find((account) => account.id === antigravityIdentity.instanceId);
  };
  return { f, logs, refresh };
}

test("Antigravity's model-group limits reach its account, read by its own CLI login outside any project", async () => {
  const { f, logs, refresh } = await antigravityHarness();
  const agy = await fakeAgy(f, true);
  const account = await refresh();
  const weekly = {
    usedPercent: 0,
    resetsAt: Date.parse("2026-10-22T14:55:01Z"),
    windowDurationMins: 10080,
    advisory: true,
  };
  expect(account?.quota.windows).toMatchObject({
    "Gemini Models · weekly": weekly,
    "Claude and GPT models · weekly": weekly,
  });
  expect(account?.availability).not.toBe("exhausted");
  expect(logs).toEqual([]);
  // One `/usage` run, with the login Antigravity's provider uses (the user's own home), in a
  // scratch directory that is gone afterwards: never the home, never a project.
  const runs = await agy.log();
  expect(runs).toHaveLength(1);
  expect(runs[0]?.home).toBe(f.normalHome);
  expect(runs[0]?.cwd.startsWith(f.normalHome)).toBe(false);
  await expect(stat(runs[0]?.cwd ?? "")).rejects.toThrow();
});

test("a signed-out agy reports sign-in-again without opening anything", async () => {
  const { f, logs, refresh } = await antigravityHarness();
  const agy = await fakeAgy(f, false);
  const account = await refresh();
  expect(account?.quota.usageNotice).toMatchObject({
    reason: "signed_out",
    message: "Sign in again in Antigravity",
  });
  expect(account?.quota.windows).toEqual({});
  expect(logs).toEqual([`${antigravityIdentity.instanceId}: Error: Sign in again in Antigravity`]);
  // Asked once, given no input to answer a prompt with: nothing was opened, nothing retried.
  expect(await agy.log()).toHaveLength(1);
  expect(await agy.browserOpened()).toBe(false);
});

test("a missing agy shows no usage", async () => {
  const { logs, refresh } = await antigravityHarness();
  const account = await refresh();
  expect(account).toBeDefined();
  expect(account?.quota.windows).toEqual({});
  expect(account?.quota.usageNotice).toBeUndefined();
  expect(logs).toEqual([]);
});
