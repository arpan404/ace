import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport, type UsageSource } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { combineProfile, readProfilePart, type ProfilePart } from "./profile-report.ts";

/*
 * The profile's year on the phone over the real SDK and in-process fake daemons: each machine's
 * part, added up across machines and worded as the web's Profile page words it.
 */

const clients: ClientCore[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((owner) => owner.close()));
});

async function connect(daemon: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-profile-test"),
    expectedHostId: HostId.parse(daemon.hostId),
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

const source = (provider: string, model: string, daily: number): UsageSource => ({
  provider,
  account: `${provider}-personal`,
  model,
  daily,
  steady: true,
  apiUsdPerMillion: null,
  billing: "subscription",
  threads: [`thread-${provider}`],
});

/** A machine whose agents spent the same every day of the year. */
function steadyMachine(host: string, sources: UsageSource[]): FakeDaemon {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: host, token: "ios-test-token" });
  daemon.services.usage.sources = sources;
  return daemon;
}

const signal = () => new AbortController().signal;
const part = async (daemon: FakeDaemon) => readProfilePart(await connect(daemon), signal());

test("one machine's steady year: every day active, a year-long streak and its providers", async () => {
  const mac = await part(steadyMachine("mac", [source("codex", "gpt-6", 3_000_000)]));
  const report = combineProfile({
    type: "profile.combine",
    machines: [{ id: "mac", name: "Mac", reach: "counted", part: mac }],
  });
  expect(report.coverage).toBeNull();
  expect(report.empty).toBe(false);
  const figures = Object.fromEntries(
    report.highlights.map((item) => [item.label.split(" · ")[0], item.value]),
  );
  expect(figures["Active days"]).toBe("365");
  expect(figures["Longest streak"]).toBe("365 days");
  expect(figures["Current streak"]).toBe("365 days");
  expect(report.providers).toEqual([{ name: "Codex", percent: 100 }]);
  // A year of weeks, every day inside it at one level, the days around it outside.
  expect(report.weeks.length).toBeGreaterThanOrEqual(53);
  const inside = report.weeks.flat().filter((level) => level >= 0);
  expect(inside).toHaveLength(365);
  expect(new Set(inside).size).toBe(1);
});

test("two machines add up, and the provider shares count both", async () => {
  const mac = await part(steadyMachine("mac", [source("codex", "gpt-6", 3_000_000)]));
  const studio = await part(steadyMachine("studio", [source("claude", "opus", 1_000_000)]));
  const alone = combineProfile({
    type: "profile.combine",
    machines: [{ id: "mac", name: "Mac", reach: "counted", part: mac }],
  });
  const both = combineProfile({
    type: "profile.combine",
    machines: [
      { id: "mac", name: "Mac", reach: "counted", part: mac },
      { id: "studio", name: "Studio", reach: "counted", part: studio },
    ],
  });
  expect(both.coverage).toBe("All 2 machines");
  const total = (report: typeof both) =>
    report.highlights.find((item) => item.label === "Tokens this year")?.value;
  expect(total(alone)).not.toBe(total(both));
  expect(both.providers).toEqual([
    { name: "Codex", percent: 75 },
    { name: "Claude Code", percent: 25 },
  ]);
});

test("a machine that can't be reached is named, and nothing counted reads as no work yet", () => {
  const report = combineProfile({
    type: "profile.combine",
    machines: [{ id: "studio", name: "Studio", reach: "offline" }],
  });
  expect(report.coverage).toBe("Studio is offline");
  expect(report.empty).toBe(true);
  expect(report.weeks).toEqual([]);
  expect(report.insights).toEqual([]);
});

test("a counted machine whose part never arrived is said to have failed, not dropped", () => {
  const empty: ProfilePart = {
    type: "profile.part",
    from: "2025-11-12",
    to: "2026-11-11",
    days: [],
    providers: [],
    models: [],
    skills: [],
    roles: [],
  };
  const report = combineProfile({
    type: "profile.combine",
    machines: [
      { id: "mac", name: "Mac", reach: "counted", part: empty },
      { id: "studio", name: "Studio", reach: "counted" },
    ],
  });
  expect(report.coverage).toBe("1 of 2 machines · Studio couldn't be read");
});

/** One machine whose tokens all went through `accounts` equal Codex accounts. */
const accountsPart = (accounts: number): ProfilePart => ({
  type: "profile.part",
  from: "2025-11-12",
  to: "2026-11-11",
  days: [{ key: "2026-11-11", tokens: accounts * 100 }],
  // Five equal Codex accounts: more than the four the web's tiles list.
  providers: Array.from({ length: accounts }, (_, index) => ({
    provider: "codex",
    account: `account-${index}`,
    tokens: 100,
  })),
  models: [],
  skills: [],
  roles: [],
});

test("one provider used through several accounts reads as that provider's whole share", () => {
  const report = combineProfile({
    type: "profile.combine",
    machines: [{ id: "mac", name: "Mac", reach: "counted", part: accountsPart(5) }],
  });
  expect(report.providers).toEqual([{ name: "Codex", percent: 100 }]);
});
