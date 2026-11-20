import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentCatalog, AgentRegistry, fileCache, fileInventoryStorage } from "@ace/agent-registry";
import { ModelCatalog, createModelDiscovery, openModelStorage } from "@ace/models";
import { spawnSupervised } from "@ace/provider-kit/process";
import { AccountService, openRegistry } from "@ace/accounts";
import {
  acpAgentUpdated,
  acpProbeFolder,
  acpProbeLauncher,
  followAcpLogins,
  registerApprovedAcpAgents,
  type AcpCatalogContext,
} from "./acp-catalog.ts";
import { acpModelInstanceId } from "./acp-model-instance.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** A registration failure fails the test. */
function fail(error: unknown): never {
  throw error;
}

/**
 * An approved agent bound to a fixture ACP server, a model catalog on a real cache file, and
 * a count of every process the catalog starts.
 */
async function daemon(binding: { acpAgentId: string; version: string }) {
  const root = await mkdtemp(join(tmpdir(), "ace-acp-catalog-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const log = join(root, "requests.log");
  const bin = join(root, "fixture-agent");
  await writeFile(
    bin,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const session = { sessionId: 'probe', configOptions: [
  { id: 'model', category: 'model', type: 'select', currentValue: 'flash',
    options: [{ value: 'flash', name: 'Flash' }, { value: 'pro', name: 'Pro' }] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }, { value: 'yolo', name: 'YOLO' }] },
] };
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify([request.method, request.params && request.params.cwd, process.env.GEMINI_CLI_TRUST_WORKSPACE]) + String.fromCharCode(10));
  const result = request.method === 'initialize' ? { protocolVersion: 1 } : request.method === 'session/new' ? session : undefined;
  console.log(JSON.stringify(result ? { jsonrpc: '2.0', id: request.id, result } : { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } }));
});
`,
    { mode: 0o700 },
  );
  const env = { HOME: home, PATH: "" };
  let id = 0;
  const agents = await AgentRegistry.open({
    catalog: await AgentCatalog.open({
      target: "darwin-aarch64",
      now: () => 1000,
      cache: fileCache(join(root, "catalog.json"), () => String(++id)),
    }),
    root: join(root, "installs"),
    target: "darwin-aarch64",
    env,
    storage: fileInventoryStorage(join(root, "inventory.json"), () => String(++id)),
  });
  cleanups.push(() => agents.close());
  const identity = {
    acpAgentId: binding.acpAgentId,
    installationId: "fixture-install",
    instanceId: "fixture-default",
  };
  await agents.bind({ ...identity, version: binding.version, command: bin, args: [] });
  let spawns = 0;
  /** With `accounts`, the agent's login is its account's, as the daemon keeps it. */
  const start = async (setup: { accounts?: boolean } = {}) => {
    const accounts = setup.accounts ? await openRegistry(join(root, "accounts.sqlite")) : undefined;
    if (accounts) cleanups.push(async () => accounts.close());
    const context: AcpCatalogContext = {
      agents,
      models: new ModelCatalog({
        storage: openModelStorage(join(root, "models.sqlite")),
        now: () => 1000,
        deadline: () => () => {},
        discover: createModelDiscovery({
          spawn(options) {
            spawns++;
            return spawnSupervised(options);
          },
          acpProbe: (instance, signal) => acpProbeLauncher(context)(instance, signal),
        }),
      }),
      options: accounts ? {} : { acpEnvironment: () => ({ env, loginRevision: "login-1" }) },
      ...(accounts
        ? {
            accountRegistry: accounts,
            accounts: new AccountService({
              registry: accounts,
              now: () => 1000,
              timeZone: "UTC",
              env,
            }),
          }
        : {}),
      dataDir,
      userHome: home,
    };
    cleanups.push(() => context.models.close());
    return context;
  };
  const requests = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line): [string, string | null, string | null] => JSON.parse(line));
  /** Changes the agent's file on disk and approves it as `version`, as Settings would. */
  const approveUpdate = async (version: string) => {
    await writeFile(bin, `${await readFile(bin, "utf8")}\n// updated\n`, { mode: 0o700 });
    const listed = await agents.handle({
      type: "registry.list",
      requestId: "list",
      offset: 0,
      limit: 50,
    });
    const update =
      listed.result.ok && "agents" in listed.result ? listed.result.updates?.[0] : undefined;
    if (!update) throw new Error("No update listed");
    const approved = await agents.handle({
      type: "registry.approve-update",
      requestId: "approve",
      ...identity,
      executableDigest: update.executableDigest,
      version,
    });
    if (!approved.result.ok) throw new Error("Update not approved");
  };
  return {
    start,
    requests,
    approveUpdate,
    identity,
    home,
    folder: acpProbeFolder(dataDir),
    row: acpModelInstanceId(identity),
    spawns: () => spawns,
  };
}

test("daemon start lists an approved agent without starting it; it loads only when the person asks", async () => {
  const d = await daemon({ acpAgentId: "local:fixture", version: "1.0.0" });
  const context = await d.start();
  await registerApprovedAcpAgents(context, fail);
  context.models.revalidate();
  expect(context.models.list({ provider: "acp" }).instances).toEqual([
    expect.objectContaining({ instance: d.row, modelProbe: "on-request" }),
  ]);
  await context.models.loadMissing();
  await context.models.refresh({ instance: d.row });
  expect(d.spawns()).toBe(0);
  await context.models.load(d.row);
  expect(d.spawns()).toBe(1);
  expect(context.models.list({ instance: d.row }).models.map((model) => model.id)).toEqual([
    "flash",
    "pro",
  ]);
  const requests = await d.requests();
  expect(requests.map(([method]) => method)).not.toContain("session/prompt");
  const opened = requests.filter(([method]) => method === "session/new");
  expect(opened).toEqual([["session/new", expect.any(String), null]]);
  // A folder of the probe's own inside ace's probe folder, gone once the probe ended.
  expect(opened[0]?.[1]?.startsWith(join(d.folder, "probe-"))).toBe(true);
  expect(await readdir(d.folder)).toEqual([]);
});

test("a restarted daemon serves an agent's cached models without starting it", async () => {
  const d = await daemon({ acpAgentId: "local:fixture", version: "1.0.0" });
  const first = await d.start();
  await registerApprovedAcpAgents(first, fail);
  await first.models.load(d.row);
  await first.models.close();
  const second = await d.start();
  await registerApprovedAcpAgents(second, fail);
  second.models.revalidate();
  expect(second.models.list({ instance: d.row }).models.map((model) => model.id)).toEqual([
    "flash",
    "pro",
  ]);
  await second.models.loadMissing();
  expect(d.spawns()).toBe(1);
});

test("Gemini lists its models before its first thread once the person loads them, in a folder ace never trusts, leaving modes to a session", async () => {
  const d = await daemon({ acpAgentId: "official:gemini", version: "0.43.0" });
  const context = await d.start();
  await registerApprovedAcpAgents(context, fail);
  // Its first start is the person's: it would start the MCP servers its own settings name.
  await context.models.loadMissing({ instance: d.row });
  expect(d.spawns()).toBe(0);
  expect(context.models.list({ instance: d.row }).instances[0]?.modelProbe).toBe("on-request");
  await context.models.load(d.row);
  expect(d.spawns()).toBe(1);
  expect(context.models.list({ instance: d.row }).instances[0]?.modelProbe).toBe("automatic");
  const loaded = context.models.list({ instance: d.row });
  expect(loaded.models.map((model) => model.id)).toEqual(["flash", "pro"]);
  // Gemini hides its privileged modes in a folder it does not trust: none are kept.
  expect(loaded.instances[0]?.permissionModes).toEqual([]);
  const requests = await d.requests();
  expect(requests.map(([method]) => method)).not.toContain("session/prompt");
  // Opened in ace's own folder, with no trust granted by environment or file.
  const opened = requests.filter(([method]) => method === "session/new");
  expect(opened).toEqual([["session/new", expect.any(String), null]]);
  expect(opened[0]?.[1]?.startsWith(join(d.folder, "probe-"))).toBe(true);
  expect(await readdir(d.folder)).toEqual([]);
  await expect(readdir(join(d.home, ".gemini"))).rejects.toThrow();
  context.models.list();
  await context.models.loadMissing();
  expect(d.spawns()).toBe(1);
});

test("an approved update moves a reviewed agent's row to the new version, which no read starts", async () => {
  const d = await daemon({ acpAgentId: "official:gemini", version: "0.43.0" });
  const context = await d.start();
  await registerApprovedAcpAgents(context, fail);
  await context.models.load(d.row);
  expect(d.spawns()).toBe(1);
  // A version outside the profile's range is no longer the agent ace reviewed.
  await d.approveUpdate("2.0.0");
  acpAgentUpdated(context, d.identity);
  const row = context.models.list({ instance: d.row });
  expect(row.instances[0]?.modelProbe).toBe("on-request");
  expect(row.models).toEqual([]);
  await context.models.refresh();
  context.models.list();
  await context.models.loadMissing();
  expect(d.spawns()).toBe(1);
});

test("an approved update the row hasn't taken yet starts nothing for a reviewed agent's row", async () => {
  const d = await daemon({ acpAgentId: "official:gemini", version: "0.43.0" });
  const context = await d.start();
  await registerApprovedAcpAgents(context, fail);
  await d.approveUpdate("2.0.0");
  await context.models.load(d.row);
  expect(d.spawns()).toBe(0);
  expect(context.models.list({ instance: d.row }).models).toEqual([]);
});

test("signing out in the agent's own CLI drops the previous login's models before any read", async () => {
  const d = await daemon({ acpAgentId: "local:fixture", version: "1.0.0" });
  const context = await d.start({ accounts: true });
  const stop = followAcpLogins(context);
  cleanups.push(async () => stop());
  await registerApprovedAcpAgents(context, fail);
  await context.models.load(d.row);
  expect(context.models.list({ instance: d.row }).models.map((model) => model.id)).toEqual([
    "flash",
    "pro",
  ]);
  // What the provider check records when `agent status` reads signed out.
  context.accountRegistry?.recordAcpAuth(d.identity.instanceId, "logged_out", 2000);
  const row = context.models.list({ instance: d.row });
  expect(row.models).toEqual([]);
  expect(row.instances[0]?.permissionModes).toEqual([]);
  expect(d.spawns()).toBe(1);
});
