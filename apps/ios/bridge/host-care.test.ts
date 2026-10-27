import { latest, native, until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { HostCare } from "./host-care.ts";
import { MachineAdmission } from "./machine-admission.ts";
import { NativeServices } from "./native-services.ts";
import { PatchPump } from "./patches.ts";
import { RecordingSink } from "./sheet-fixture.ts";

/*
 * A machine's Storage, Diagnostics and "Pause new work" over the real SDK and an in-process
 * fake daemon, as the phone's native service calls reach them.
 */

const day = 86_400_000;
const now = 200 * day;
const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
const clients: ClientCore[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  native.frames.length = 0;
});

function daemon(scopes?: Record<string, ("read" | "operate" | "admin")[]>): FakeDaemon {
  return new FakeDaemon({
    clock: () => now,
    hostId: "ios-test-host",
    token: "ios-test-token",
    ...(scopes ? { deviceScopes: scopes } : {}),
  });
}

async function connect(fixture: FakeDaemon, device = "ios-care-test"): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse(device),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(fixture),
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
    now: () => now,
  });
  clients.push(owner);
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return owner;
}

/** Answers one native service call the way Swift sees it: ok with a value, or the words. */
async function call(services: NativeServices, sink: RecordingSink, request: unknown) {
  const id = crypto.randomUUID();
  services.handle({ type: "service", id, request });
  return until(() => sink.read(`service:${id}`)) as Promise<{
    ok: boolean;
    value: Record<string, unknown> & { plan?: Record<string, unknown> };
    message: string;
  }>;
}

async function phone(fixture: FakeDaemon, device?: string) {
  const owner = await connect(fixture, device);
  const sink = new RecordingSink();
  const admission = new MachineAdmission(owner, pump);
  const services = new NativeServices(
    owner,
    sink,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new HostCare(owner, admission),
  );
  return { owner, sink, services, admission };
}

const logs = [
  {
    id: "old-log",
    kind: "logs" as const,
    label: "logs/ace.1.jsonl",
    bytes: 1024,
    modifiedAt: 1,
    threadIds: [],
    fingerprint: "old",
    protections: [],
    eligibleReason: "expired" as const,
  },
  {
    id: "live-log",
    kind: "logs" as const,
    label: "logs/ace.jsonl",
    bytes: 2048,
    modifiedAt: 1,
    threadIds: [],
    fingerprint: "live",
    protections: ["leased" as const],
    eligibleReason: "expired" as const,
  },
];

test("storage reads its usage in words and a cleanup names what goes before removing it", async () => {
  const fixture = daemon();
  fixture.seedServices({
    storageItems: logs,
    storageDatabase: { bytes: 4 * 1024 ** 2, reclaimable: 1024 ** 2 },
  });
  const { services, sink } = await phone(fixture);
  const page = await call(services, sink, { type: "host.storage" });
  expect(page.ok).toBe(true);
  expect(page.value.usage).toMatchObject({
    rows: expect.arrayContaining([
      { kind: "logs", title: "Logs and support bundles", detail: "2 items", size: "3.0 KB" },
    ]),
    database: { size: "4.0 MB", detail: "1.0 MB can be reclaimed by compacting." },
  });

  const preview = await call(services, sink, {
    type: "host.storage.preview",
    worktrees: false,
    forceItems: [],
  });
  const plan = preview.value.plan as {
    id: string;
    summary: string;
    items: { id: string; line: string; removes: boolean }[];
    action: string;
    confirm: { title: string; message: string };
  };
  expect(plan.summary).toBe("1 item to remove · 1.0 KB of data. 1 protected.");
  expect(plan.items.find((item) => item.id === "live-log")).toMatchObject({
    removes: false,
    line: "Keep · Currently in use",
  });
  expect(plan.action).toBe("Remove 1 item");
  expect(plan.confirm.title).toBe("Remove 1 item?");
  expect(plan.confirm.message).toMatch(
    /^Logs and support bundles: 1, 1\.0 KB in all, will be permanently removed\./,
  );

  const applied = await call(services, sink, { type: "host.storage.apply", planId: plan.id });
  const after = applied.value.plan as {
    items: { id: string; outcome: string | null }[];
    action: string | null;
    outcome: string;
  };
  expect(after.items.find((item) => item.id === "old-log")?.outcome).toBe("Removed");
  expect(after.action).toBeNull();
  expect(after.outcome).toBe("Cleanup finished. Items that became protected were kept.");
  const measured = await call(services, sink, { type: "host.storage" });
  expect(measured.value.usage).toMatchObject({
    rows: expect.arrayContaining([expect.objectContaining({ kind: "logs", detail: "1 item" })]),
  });
});

test("a removal of a preview this phone no longer holds says to preview again", async () => {
  const { services, sink } = await phone(daemon());
  const reply = await call(services, sink, { type: "host.storage.apply", planId: "gone" });
  expect(reply).toMatchObject({
    ok: false,
    message: "This preview expired. Preview cleanup again.",
  });
});

test("storage settings save in the person's units and refuse values out of range", async () => {
  const { services, sink } = await phone(daemon());
  const saved = await call(services, sink, {
    type: "host.storage.set",
    setting: { key: "logMegabytes", megabytes: 128 },
  });
  expect(saved.value.settings).toMatchObject({ logMegabytes: { value: 128, pinnedBy: null } });
  const kind = await call(services, sink, {
    type: "host.storage.set",
    setting: { key: "kind", kind: "caches", days: null },
  });
  const kinds = (kind.value.settings as { kinds: { kind: string; days: number | null }[] }).kinds;
  expect(kinds.find((entry) => entry.kind === "caches")?.days).toBeNull();
  expect(kinds.find((entry) => entry.kind === "logs")?.days).toBe(14);
  const refused = await call(services, sink, {
    type: "host.storage.set",
    setting: { key: "retentionDays", days: 0 },
  });
  expect(refused).toMatchObject({ ok: false, message: "Keep data for 1 to 3650 days." });
});

test("diagnostics runs the read-only checks and words each one, leaving provider checks out", async () => {
  const { services, sink } = await phone(daemon());
  const checks = await call(services, sink, { type: "host.checks" });
  const rows = checks.value.rows as { id: string; label: string; word: string }[];
  expect(rows.some((row) => row.id.startsWith("provider."))).toBe(false);
  expect(rows.find((row) => row.id === "node")).toMatchObject({
    label: "App runtime",
    word: "Passed",
  });
  expect(typeof checks.value.summary).toBe("string");
  const page = await call(services, sink, { type: "host.diagnostics" });
  expect(page.value.health).toMatchObject({
    rows: expect.arrayContaining([expect.objectContaining({ label: "Memory" })]),
  });
  expect(page.value.worktreeTimeout).toMatchObject({ minutes: 10, pinnedBy: null });
  const timeout = await call(services, sink, { type: "host.worktreeTimeout", minutes: 25 });
  expect(timeout.value.worktreeTimeout).toMatchObject({ minutes: 25 });
  const refused = await call(services, sink, { type: "host.worktreeTimeout", minutes: 90 });
  expect(refused).toMatchObject({ ok: false, message: "Use 1 to 60 minutes." });
});

test("the support bundle arrives as a file the phone can share", async () => {
  const { services, sink } = await phone(daemon());
  const bundle = await call(services, sink, { type: "host.support", includeThreads: false });
  expect(bundle.value.name).toBe("ace-support.tar.gz");
  expect(atob(String(bundle.value.data))).toBe("Redacted support fixture without conversations");
});

test("pausing new work shows on every phone of the machine, and resuming clears it", async () => {
  const fixture = daemon();
  const first = await phone(fixture, "ios-care-first");
  await phone(fixture, "ios-care-second");
  await until(() => latest("machine.admission")?.known === true);
  expect(latest("machine.admission")).toMatchObject({
    paused: false,
    line: null,
    action: "Pause new work",
  });
  const paused = await call(first.services, first.sink, {
    type: "machine.admission.set",
    paused: true,
  });
  expect(paused.value).toMatchObject({ paused: true, action: "Resume new work" });
  await until(() => latest("machine.admission")?.paused === true);
  expect(latest("machine.admission")?.line).toBe("New work paused · nothing is running");
  await call(first.services, first.sink, { type: "machine.admission.set", paused: false });
  await until(() => latest("machine.admission")?.paused === false);
});

test("a view-only phone sees the pause but is told it can't change it", async () => {
  const fixture = daemon({ "ios-care-view": ["read"] });
  const viewer = await phone(fixture, "ios-care-view");
  await until(() => latest("machine.admission")?.known === true);
  const refused = await call(viewer.services, viewer.sink, {
    type: "machine.admission.set",
    paused: true,
  });
  expect(refused).toMatchObject({
    ok: false,
    message: "This phone can view this computer but can't pause it. Pair it with full access.",
  });
});
