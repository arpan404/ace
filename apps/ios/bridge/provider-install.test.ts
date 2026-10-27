import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { RecordingSink } from "./sheet-fixture.ts";
import type { InstallScreen } from "./provider-install.ts";
import type { OtherProvider } from "./provider-page-view.ts";

/*
 * Installing a provider's CLI from its page over the real SDK and an in-process fake daemon:
 * the plan is shown before anything runs, the job's progress reaches the phone, it can be
 * cancelled, and the provider's readiness changes once it finishes.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function open(daemon: FakeDaemon) {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-provider-install-test"),
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
  const ask = async <T>(request: Record<string, unknown>): Promise<T> => {
    const id = `call-${next++}`;
    services.handle({ type: "service", id, request });
    await until(() => sink.read(`service:${id}`));
    const reply = sink.read(`service:${id}`) as { ok: boolean; value: T; message: string };
    if (!reply.ok) throw new Error(reply.message);
    return reply.value;
  };
  const act = (provider: string, step: Record<string, unknown>) =>
    ask<InstallScreen>({ type: "provider.install.act", provider, step });
  const watch = (provider: string, after: number) =>
    ask<InstallScreen>({ type: "provider.install.watch", provider, after });
  /** Waits through each change until `done` holds. */
  const settle = async (provider: string, done: (screen: InstallScreen) => boolean) => {
    let screen = await watch(provider, -1);
    for (let tries = 0; tries < 20 && !done(screen); tries++)
      screen = await watch(provider, screen.revision);
    return screen;
  };
  const missing = async () =>
    (await ask<{ missing: OtherProvider[] }>({ type: "providers.others" })).missing.map(
      (row) => row.provider,
    );
  return { act, watch, settle, missing };
}

function fixture(): FakeDaemon {
  return new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
    displayName: "studio",
  });
}

test("installing shows what will run and where before anything runs", async () => {
  const daemon = fixture();
  const phone = await open(daemon);
  const plan = await phone.act("claude", { kind: "plan", action: "update" });
  expect(plan.title).toBe("Update Claude Code");
  expect(plan.facts).toContainEqual({ term: "Runs on", value: "studio" });
  expect(plan.lines.length).toBeGreaterThan(0);
  expect(plan.confirm).toEqual({ label: "Update", destructive: false });
  expect(plan.busy).toBe(false);
});

test("an install runs from its plan to Installed and the provider leaves Not installed", async () => {
  const daemon = fixture();
  const phone = await open(daemon);
  expect(await phone.missing()).toEqual(["antigravity"]);
  await phone.act("antigravity", { kind: "plan", action: "install" });
  await phone.act("antigravity", { kind: "run" });
  const done = await phone.settle("antigravity", (screen) => screen.finished);
  expect(done.status).toEqual({ label: "Installed", token: "done" });
  expect(done.changed).toBe(true);
  expect(await phone.missing()).toEqual([]);
});

test("an install in progress can be cancelled, then retried", async () => {
  const daemon = fixture();
  daemon.services.providerInstalls.autoComplete = false;
  const phone = await open(daemon);
  await phone.act("codex", { kind: "plan", action: "update" });
  const running = await phone.act("codex", { kind: "run" });
  expect(running).toMatchObject({ busy: true, cancel: true });
  expect(running.status?.token).toBe("working");
  await phone.act("codex", { kind: "cancel" });
  const cancelled = await phone.settle("codex", (screen) => screen.finished);
  expect(cancelled.status?.label).toBe("Cancelled");
  expect(cancelled.retry).toEqual({ action: "update" });
});

test("a failed install says so with the installer's words and offers Retry", async () => {
  const daemon = fixture();
  daemon.services.providerInstalls.scenarios.codex = "failure";
  const phone = await open(daemon);
  await phone.act("codex", { kind: "plan", action: "update" });
  await phone.act("codex", { kind: "run" });
  const failed = await phone.settle("codex", (screen) => screen.finished);
  expect(failed.status).toEqual({ label: "Update failed", token: "failed" });
  expect(failed.message).toBe("The official installer failed. Try again.");
  expect(failed.retry).toEqual({ action: "update" });
});

test("leaving the page and coming back shows the same job", async () => {
  const daemon = fixture();
  daemon.services.providerInstalls.autoComplete = false;
  const phone = await open(daemon);
  await phone.act("codex", { kind: "plan", action: "update" });
  await phone.act("codex", { kind: "run" });
  const again = await phone.watch("codex", -1);
  expect(again).toMatchObject({ busy: true, title: "Update Codex" });
});

test("a plan that needs administrator approval runs nothing from the phone", async () => {
  const daemon = fixture();
  daemon.services.providerInstalls.scenarios.codex = "needs_admin";
  const phone = await open(daemon);
  const plan = await phone.act("codex", { kind: "plan", action: "update" });
  expect(plan.confirm).toBeNull();
  expect(plan.status).toEqual({ label: "Approval needed", token: "needsYou" });
  expect(plan.message).toBe(
    "This installer needs administrator approval. Run the command in a terminal on studio.",
  );
});

test("removing a CLI asks first, in red", async () => {
  const daemon = fixture();
  const phone = await open(daemon);
  const plan = await phone.act("codex", { kind: "plan", action: "uninstall" });
  expect(plan.confirm).toEqual({ label: "Remove CLI", destructive: true });
  expect(plan.message).toBe(
    "Remove Codex's CLI from studio? Sign-ins and conversations stay saved.",
  );
});
