import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId, type ProviderStatus } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { RecordingSink } from "./sheet-fixture.ts";
import type { FirstRunReply, FirstRunScreen } from "./first-run.ts";

/*
 * The phone's first run on a newly paired computer, over the real SDK and an in-process fake
 * daemon: whether it is offered, what each agent needs, and that Skip is kept by the daemon for
 * this phone so Settings can bring it back.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

const base = { runtime: "cli", checkedAt: 1000, stale: false, refreshing: false } as const;
const signedIn = (provider: "claude" | "codex"): ProviderStatus => ({
  ...base,
  provider,
  installed: true,
  version: "1.0.0",
  auth: "logged_in",
  accountLabel: "ada@example.com",
  loginHint: `${provider} login`,
});
const signedOut = (provider: "claude" | "codex"): ProviderStatus => ({
  ...base,
  provider,
  installed: true,
  version: "1.0.0",
  auth: "logged_out",
  loginHint: `${provider} login`,
});
const missing = (provider: "claude" | "codex" | "opencode"): ProviderStatus => ({
  ...base,
  provider,
  installed: false,
  auth: "unknown",
  loginHint: `${provider} login`,
});

async function open(statuses: ProviderStatus[]) {
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
    displayName: "studio",
  });
  daemon.services.providerStatuses = statuses;
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-first-run-test"),
    expectedHostId: HostId.parse("ios-test-host"),
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
  client = owner;
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  const sink = new RecordingSink();
  const services = new NativeServices(owner, sink);
  let next = 0;
  const ask = async (request: Record<string, unknown>): Promise<FirstRunScreen> => {
    const id = `call-${next++}`;
    services.handle({ type: "service", id, request });
    await until(() => sink.read(`service:${id}`));
    const reply = sink.read(`service:${id}`) as { ok: boolean; value: FirstRunReply };
    if (!reply.ok || !reply.value.ok) throw new Error("setup refused");
    return reply.value.screen;
  };
  return {
    daemon,
    read: () => ask({ type: "setup.read" }),
    dismiss: (dismissed: boolean) => ask({ type: "setup.dismiss", dismissed }),
  };
}

test("a computer with a signed-in agent skips the first run", async () => {
  const phone = await open([signedIn("claude"), signedOut("codex")]);
  const screen = await phone.read();
  expect(screen.offer).toBe(false);
  expect(screen.progress).toBe("1 of 2 ready");
  expect(screen.installed.map((row) => [row.name, row.status.label, row.step])).toEqual([
    ["Claude Code", "Ready", null],
    ["Codex", "Sign in needed", "sign_in"],
  ]);
});

test("a signed-out agent is offered first, with sign-in as its step", async () => {
  const phone = await open([signedOut("codex"), missing("claude")]);
  const screen = await phone.read();
  expect(screen.offer).toBe(true);
  expect(screen.progress).toBe("0 of 1 ready");
  expect(screen.installed).toEqual([
    expect.objectContaining({ name: "Codex", step: "sign_in", next: true, ready: false }),
  ]);
  expect(screen.missing).toEqual([
    expect.objectContaining({ name: "Claude Code", step: "install", next: false }),
  ]);
});

test("with no agent installed, every one offers an install and one is suggested", async () => {
  const phone = await open([missing("claude"), missing("codex"), missing("opencode")]);
  const screen = await phone.read();
  expect(screen.offer).toBe(true);
  expect(screen.installed).toEqual([]);
  expect(screen.missing.map((row) => [row.name, row.status.label, row.step])).toEqual([
    ["Claude Code", "Not installed", "install"],
    ["Codex", "Not installed", "install"],
    ["OpenCode", "Not installed", "install"],
  ]);
  expect(screen.missing.filter((row) => row.next)).toHaveLength(1);
});

test("Skip is kept for this phone, and Settings can bring the first run back", async () => {
  const phone = await open([missing("claude")]);
  const skipped = await phone.dismiss(true);
  expect(skipped.offer).toBe(false);
  expect((await phone.read()).offer).toBe(false);
  const resumed = await phone.dismiss(false);
  expect(resumed.offer).toBe(true);
  expect((await phone.read()).dismissed).toBe(false);
});

test("signing in on the computer makes the first run say it is ready", async () => {
  const phone = await open([signedOut("codex")]);
  expect((await phone.read()).offer).toBe(true);
  // The CLI's sign-in finished in a terminal on the computer; the next read sees it.
  phone.daemon.services.providerStatuses = [signedIn("codex")];
  const screen = await phone.read();
  expect(screen.offer).toBe(false);
  expect(screen.installed[0]).toMatchObject({
    ready: true,
    step: null,
    status: { label: "Ready" },
  });
});
