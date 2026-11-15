import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport, type UsageSource } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { usageDay } from "@ace/ui-core";
import {
  combineLedger,
  readLedgerPart,
  type UsageLedgerPart,
  type UsageLedgerPartRequest,
} from "./usage-ledger.ts";

/*
 * The Usage screen's ledger over the real SDK and in-process fake daemons: each machine reads its
 * part for one grouping, named on that machine, and the web's ledger sums them for the phone.
 */

const clients: ClientCore[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((owner) => owner.close()));
});

async function connect(daemon: FakeDaemon, host: string): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-usage-ledger-test"),
    expectedHostId: HostId.parse(host),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  clients.push(owner);
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return owner;
}

const source = (provider: string, account: string, daily: number): UsageSource => ({
  provider,
  account,
  model: provider === "claude" ? "claude-opus-4-6" : "gpt-5.3-codex",
  daily,
  steady: true,
  apiUsdPerMillion: 10,
  billing: "subscription",
  threads: [`thread-${account}`],
});

/** A machine whose usage runs on the sources given, every day alike. */
async function machine(host: string, sources: UsageSource[]) {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: host, token: "ios-test-token" });
  daemon.services.usage.sources = sources;
  return connect(daemon, host);
}

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const span = { from: usageDay(Date.now(), zone, 6), to: usageDay(Date.now(), zone) };
const signal = () => new AbortController().signal;
const part = (owner: ClientCore, request: Partial<UsageLedgerPartRequest>) =>
  readLedgerPart(
    owner,
    { type: "usage.ledgerPart", group: "provider", ...span, filters: {}, ...request },
    signal(),
  );
const counted = (id: string, name: string, read: UsageLedgerPart) => ({
  id,
  name,
  reach: "counted" as const,
  part: read,
});

test("two machines' spend sums per provider, largest first, each with its share and trend", async () => {
  const mac = await machine("mac", [source("claude", "claude-personal", 3_000_000)]);
  const studio = await machine("studio", [
    source("claude", "claude-personal", 1_000_000),
    source("codex", "codex-personal", 1_000_000),
  ]);
  const ledger = combineLedger({
    type: "usage.combineLedger",
    group: "provider",
    ...span,
    machines: [
      counted("mac", "Mac", await part(mac, {})),
      counted("studio", "Studio", await part(studio, {})),
    ],
  });
  expect(ledger.rows.map((row) => row.name)).toEqual(["Claude Code", "Codex"]);
  const [claude, codex] = ledger.rows;
  // Four parts in five: Claude on both machines, Codex on one.
  expect(claude?.share.tokens).toBeCloseTo(0.8, 5);
  expect(codex?.share.tokens).toBeCloseTo(0.2, 5);
  expect(claude?.cost.figure).toMatch(/^\$/);
  expect(claude?.trend.tokens).toHaveLength(7);
  // A provider opens to its accounts.
  expect(ledger.next).toEqual({ value: "account", label: "Account" });
  expect(ledger.groups.map((each) => each.label)).toContain("Project");
});

test("a provider opened to its accounts names each account without the provider's name", async () => {
  const mac = await machine("mac", [
    source("claude", "claude-personal", 3_000_000),
    source("claude", "claude-work", 1_000_000),
    source("codex", "codex-personal", 1_000_000),
  ]);
  const read = await part(mac, { group: "account", filters: { provider: ["claude"] } });
  const ledger = combineLedger({
    type: "usage.combineLedger",
    group: "account",
    ...span,
    parent: { group: "provider", label: "Claude Code" },
    machines: [counted("mac", "Mac", read)],
  });
  expect(ledger.rows.map((row) => row.key)).toEqual(["claude-personal", "claude-work"]);
  expect(ledger.rows.map((row) => row.name)).toEqual(["Personal", "Work"]);
  expect(ledger.next).toEqual({ value: "workspace", label: "Project" });
});

test("grouped by machine, each machine is one row under its own name; an offline one is named", async () => {
  const mac = await machine("mac", [source("claude", "claude-personal", 3_000_000)]);
  const ledger = combineLedger({
    type: "usage.combineLedger",
    group: "machine",
    ...span,
    machines: [
      counted("mac", "Mac", await part(mac, { group: "machine" })),
      { id: "studio", name: "Studio", reach: "offline" },
    ],
  });
  expect(ledger.rows.map((row) => row.name)).toEqual(["Mac"]);
  expect(ledger.coverage.line).toMatch(/Studio/);
});
