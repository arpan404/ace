import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { combineLimits, readUsageAccounts, useBankedReset } from "./usage-limits.ts";
import { RecordingSink } from "./sheet-fixture.ts";

/*
 * The Usage screen's Limits view over the real SDK and in-process fake daemons: each machine
 * answers its accounts, and the shared `usageLimits` words reach the phone combined across
 * machines, naming any machine that isn't counted.
 */

const clients: ClientCore[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((owner) => owner.close()));
});

async function connect(daemon: FakeDaemon, host = "ios-test-host"): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-usage-test"),
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

function fixture(host = "ios-test-host"): FakeDaemon {
  return new FakeDaemon({ clock: Date.now, hostId: host, token: "ios-test-token" });
}

const signal = () => new AbortController().signal;

/** Gives the machine's Personal Codex account a sign-in, so another machine can match it. */
function signIn(daemon: FakeDaemon, who: string, usedPercent?: number, at?: number) {
  daemon.services.accounts = daemon.services.accounts.map((account) =>
    account.provider === "codex" && account.label === "Personal"
      ? {
          ...account,
          signedInAs: who,
          quota: {
            ...account.quota,
            observedAt: at ?? account.quota.observedAt,
            windows: Object.fromEntries(
              Object.entries(account.quota.windows).map(([id, window]) => [
                id,
                usedPercent === undefined
                  ? window
                  : { ...window, usedPercent, ...(at === undefined ? {} : { observedAt: at }) },
              ]),
            ),
          },
        }
      : account,
  );
}

test("one machine's limits shape each provider's accounts with what is left of every window", async () => {
  const owner = await connect(fixture());
  const { accounts } = await readUsageAccounts(owner, false, signal());
  const reply = combineLimits(
    {
      type: "usage.combineLimits",
      machines: [{ id: "mac", name: "Mac", reach: "counted", accounts }],
    },
    Date.now(),
  );
  expect(reply.coverage.line).toBeNull();
  const codex = reply.providers.find((group) => group.provider === "codex");
  expect(codex?.providerLabel).toBe("Codex");
  const personal = codex?.accounts.find((account) => account.label === "Personal");
  expect(personal).toMatchObject({ plan: "pro", bankedResets: 3, signIn: null, machine: null });
  const session = personal?.windows.find((window) => window.label === "Session (5h)");
  expect(session).toMatchObject({ leftPercent: 62, stale: false });
  expect(session?.resets).toMatch(/^Resets in /);
  // Providers whose accounts report no window join the quiet line instead of guessing.
  expect(reply.quiet.length).toBeGreaterThan(0);
});

test("two machines' limits list each account under its machine, and an offline one is named", async () => {
  const mac = await readUsageAccounts(await connect(fixture()), false, signal());
  const reply = combineLimits(
    {
      type: "usage.combineLimits",
      machines: [
        { id: "mac", name: "Mac", reach: "counted", accounts: mac.accounts },
        { id: "studio", name: "Studio", reach: "offline" },
        { id: "mini", name: "Mini", reach: "counted", accounts: mac.accounts },
      ],
    },
    Date.now(),
  );
  expect(reply.coverage).toEqual({ line: "2 of 3 machines · Studio is offline", complete: false });
  const codex = reply.providers.find((group) => group.provider === "codex");
  const personal = codex?.accounts.filter((account) => account.label === "Personal");
  expect(personal?.map((account) => [account.machine, account.machineId])).toEqual([
    ["Mac", "mac"],
    ["Mini", "mini"],
  ]);
  // Nothing says who they're signed in as, so the phone says it can't tell rather than guess.
  expect(reply.unsure).toContain(
    "Can't tell whether the Codex accounts on Mac and Mini are the same; each is listed.",
  );
});

test("one login signed in on two machines is listed once, with the fresher machine's reading", async () => {
  const macDaemon = fixture("ios-mac");
  const studioDaemon = fixture("ios-studio");
  const now = Date.now();
  signIn(macDaemon, "me@example.com", 80, now - 3_600_000);
  signIn(studioDaemon, "ME@example.com", 20, now);
  const mac = await readUsageAccounts(await connect(macDaemon, "ios-mac"), false, signal());
  const studio = await readUsageAccounts(
    await connect(studioDaemon, "ios-studio"),
    false,
    signal(),
  );
  const reply = combineLimits(
    {
      type: "usage.combineLimits",
      machines: [
        { id: "mac", name: "Mac", reach: "counted", accounts: mac.accounts },
        { id: "studio", name: "Studio", reach: "counted", accounts: studio.accounts },
      ],
    },
    now,
  );
  expect(reply.coverage.line).toBe("All 2 machines");
  const personal = reply.providers
    .find((group) => group.provider === "codex")
    ?.accounts.filter((account) => account.label === "Personal");
  expect(personal).toHaveLength(1);
  expect(personal?.[0]).toMatchObject({ machine: "Mac and Studio", machineId: "studio" });
  expect(personal?.[0]?.windows.every((window) => window.leftPercent === 80)).toBe(true);
});

test("refresh asks the machine's CLIs and answers its accounts through the service bridge", async () => {
  const owner = await connect(fixture());
  const sink = new RecordingSink();
  new NativeServices(owner, sink).handle({
    type: "service",
    id: "refresh",
    request: { type: "usage.refreshLimits" },
  });
  await until(() => sink.read("service:refresh"));
  expect(sink.read("service:refresh")).toMatchObject({
    ok: true,
    value: { type: "usage.accounts", accounts: expect.arrayContaining([expect.anything()]) },
  });
});

test("a machine that refuses its accounts fails its read like other service reads", async () => {
  const daemon = fixture();
  daemon.failRequests("accounts.list");
  const owner = await connect(daemon);
  const sink = new RecordingSink();
  new NativeServices(owner, sink).handle({
    type: "service",
    id: "limits",
    request: { type: "usage.accounts" },
  });
  await until(() => sink.read("service:limits"));
  expect(sink.read("service:limits")).toMatchObject({ ok: false, value: null });
});

test("a machine whose accounts never arrived reads as couldn't be read, not as counted", () => {
  const reply = combineLimits(
    {
      type: "usage.combineLimits",
      machines: [
        { id: "mac", name: "Mac", reach: "counted", accounts: [] },
        { id: "studio", name: "Studio", reach: "counted" },
      ],
    },
    Date.now(),
  );
  expect(reply.coverage.line).toBe("1 of 2 machines · Studio couldn't be read");
});

test("a banked Codex reset spends one credit, and the same attempt never spends a second", async () => {
  const owner = await connect(fixture());
  const limits = async () =>
    combineLimits(
      {
        type: "usage.combineLimits",
        machines: [
          {
            id: "mac",
            name: "Mac",
            reach: "counted",
            accounts: (await readUsageAccounts(owner, false, signal())).accounts,
          },
        ],
      },
      Date.now(),
    );
  const personal = (await limits()).providers
    .find((group) => group.provider === "codex")
    ?.accounts.find((account) => account.label === "Personal");
  if (!personal) throw new Error("expected the Personal Codex account");
  const attempt = {
    type: "usage.useReset" as const,
    instanceId: personal.instanceId,
    idempotencyKey: crypto.randomUUID(),
  };
  expect(await useBankedReset(owner, attempt, signal())).toMatchObject({
    outcome: "reset",
    words: "Limits reset.",
  });
  expect(await useBankedReset(owner, attempt, signal())).toMatchObject({
    outcome: "alreadyRedeemed",
    words: "This reset was already applied.",
  });
  const reset = (await limits()).providers
    .find((group) => group.provider === "codex")
    ?.accounts.find((account) => account.key === personal.key);
  expect(reset?.bankedResets).toBe(2);
  expect(reset?.windows.every((window) => window.leftPercent === 100)).toBe(true);
});
