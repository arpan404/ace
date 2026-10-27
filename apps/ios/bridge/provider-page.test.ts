import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { RecordingSink } from "./sheet-fixture.ts";
import type { OtherProvider, ProviderPage } from "./provider-page-view.ts";

/*
 * A provider's Settings page over the real SDK and an in-process fake daemon: what the page
 * says about a provider, and that each edit from the phone lands in the daemon's own settings
 * and shows on the next read.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function open(daemon = fixture()) {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-provider-page-test"),
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
  return {
    page: (provider: string) => ask<ProviderPage>({ type: "provider.page", provider }),
    others: () =>
      ask<{ off: OtherProvider[]; missing: OtherProvider[] }>({ type: "providers.others" }),
    edit: (provider: string, change: Record<string, unknown>) =>
      ask<{ ok: boolean; message?: string }>({ type: "provider.edit", provider, change }),
    ask,
  };
}

function fixture(): FakeDaemon {
  return new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
    displayName: "studio",
  });
}

test("a signed-out CLI with a newer release offers sign-in first and says the update", async () => {
  const phone = await open();
  const codex = await phone.page("codex");
  expect(codex.name).toBe("Codex");
  expect(codex.fix).toEqual({ action: "sign_in", label: "Sign in" });
  expect(codex.status.token).toBe("needsYou");
  expect(codex.update).toBe("0.161.0 available");
  expect(codex.updateToo).toBe(true);
  expect(codex.terminal).toEqual({ run: "codex login", prompt: null });
  expect(codex.accounts).toBe(true);
  expect(codex.missing).toBe(false);
});

test("an API key is pointed at the computer's own ace, never taken on the phone", async () => {
  const phone = await open();
  const codex = await phone.page("codex");
  expect(codex.apiKey).toBe("Add an API key in ace on studio.");
  const claude = await phone.page("claude");
  expect(claude.apiKey).toBeNull();
});

test("a provider turned off moves to its own list and turns back on from its page", async () => {
  const phone = await open();
  expect((await phone.edit("claude", { kind: "enabled", on: false })).ok).toBe(true);
  const off = await phone.page("claude");
  expect(off).toMatchObject({ off: true, fix: { action: "turn_on", label: "Turn on" } });
  expect(off.status.label).toBe("Turned off");
  expect((await phone.others()).off.map((row) => row.provider)).toEqual(["claude"]);
  await phone.edit("claude", { kind: "enabled", on: true });
  expect((await phone.page("claude")).off).toBe(false);
  expect((await phone.others()).off).toEqual([]);
});

test("a relative CLI path is refused in words and leaves the saved path alone", async () => {
  const phone = await open();
  await phone.edit("codex", { kind: "path", value: "/opt/homebrew/bin/codex" });
  const refused = await phone.edit("codex", { kind: "path", value: "bin/codex" });
  expect(refused).toEqual({
    ok: false,
    message: "Enter the full path to the executable, or clear it to find the CLI automatically.",
  });
  expect((await phone.page("codex")).settings.path).toBe("/opt/homebrew/bin/codex");
  await phone.edit("codex", { kind: "path", value: "" });
  expect((await phone.page("codex")).settings.path).toBe("");
});

test("Cursor's checkpoint budget takes 1 to 256 MB and other providers have none", async () => {
  const phone = await open();
  expect((await phone.edit("cursor", { kind: "checkpoint", value: "300" })).ok).toBe(false);
  await phone.edit("cursor", { kind: "checkpoint", value: "64" });
  const cursor = await phone.page("cursor");
  expect(cursor.settings).toMatchObject({ checkpoint: "64", path: null, removable: false });
  expect((await phone.page("codex")).settings.checkpoint).toBeNull();
});

test("hiding a model takes it out of the picker's count and showing it brings it back", async () => {
  const phone = await open();
  const before = (await phone.page("claude")).models;
  const model = before?.groups[0]?.models.find((row) => !row.hidden);
  if (!before || !model) throw new Error("expected Claude to list a shown model");
  await phone.edit("claude", {
    kind: "modelHidden",
    id: model.id,
    aliases: model.aliases,
    hidden: false,
  });
  const after = (await phone.page("claude")).models;
  const row = after?.groups
    .flatMap((group) => group.models)
    .find((entry) => entry.key === model.key);
  expect(row?.hidden).toBe(true);
  expect(after?.shown).not.toBe(before.shown);
  await phone.edit("claude", { kind: "modelHidden", id: model.id, aliases: [], hidden: true });
  expect((await phone.page("claude")).models?.shown).toBe(before.shown);
});

test("a chosen default model reads as the person's choice until reset", async () => {
  const phone = await open();
  const models = (await phone.page("claude")).models;
  const other = models?.defaultModel?.choices.find((choice) => !choice.current);
  if (!other) throw new Error("expected a second Claude model");
  await phone.edit("claude", { kind: "defaultModel", id: other.id });
  const chosen = (await phone.page("claude")).models?.defaultModel;
  expect(chosen).toMatchObject({ label: other.label, note: "Your choice", resettable: true });
  await phone.edit("claude", { kind: "defaultModel", id: null });
  expect((await phone.page("claude")).models?.defaultModel?.note).toBeNull();
});

test("a custom model is added once and removed from the page", async () => {
  const phone = await open();
  await phone.edit("pi", { kind: "addCustom", id: "local/qwen", name: "Qwen local" });
  const twice = await phone.edit("pi", { kind: "addCustom", id: "local/qwen", name: "Again" });
  expect(twice).toEqual({ ok: false, message: "That model is already added." });
  expect((await phone.page("pi")).models?.custom).toEqual([
    { id: "local/qwen", displayName: "Qwen local" },
  ]);
  await phone.edit("pi", { kind: "removeCustom", id: "local/qwen" });
  expect((await phone.page("pi")).models?.custom).toEqual([]);
});

test("a native mode is chosen from the provider's own modes and cleared back to ace's", async () => {
  const phone = await open();
  const row = (await phone.page("codex")).settings.nativeMode;
  const mode = row?.options.find((option) => option.id !== "");
  if (!row || !mode) throw new Error("expected Codex to offer native modes");
  expect(row.value).toBe("");
  await phone.edit("codex", { kind: "nativeMode", mode: mode.id });
  expect((await phone.page("codex")).settings.nativeMode).toMatchObject({
    value: mode.id,
    label: mode.label,
  });
  await phone.edit("codex", { kind: "nativeMode", mode: "" });
  expect((await phone.page("codex")).settings.nativeMode?.value).toBe("");
});

test("a provider that isn't installed is listed apart, with Install", async () => {
  const phone = await open();
  const others = await phone.others();
  expect(others.missing).toEqual([
    expect.objectContaining({ provider: "antigravity", name: "Antigravity", installable: true }),
  ]);
  const page = await phone.page("antigravity");
  expect(page).toMatchObject({ missing: true, fix: { action: "install", label: "Install" } });
  expect(page.models).toBeNull();
});
