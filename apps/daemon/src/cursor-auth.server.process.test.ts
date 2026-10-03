import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CursorAuthService, openRegistry, createInstance } from "@ace/accounts";
import { cursorAuthInHost } from "@ace/adapter-cursor";
import { DeviceId, type CursorAuthEvent } from "@ace/protocol";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { fixture } from "./socket-test-support.ts";

const file = (instance: ProviderInstance) =>
  join(instance.homeDir, "user", ".cursor", "sdk", "auth.json");
const credentialAbsent = async (path: string) => {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
};

it("remote devices drive isolated SDK browser login and cannot poll another device's challenge", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-auth-wire-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const browser = Promise.withResolvers<void>();
  const authorize = Promise.withResolvers<void>();
  const timers = new Set<() => void>();
  const operate = async (
    method: "login" | "status" | "logout",
    instance: ProviderInstance,
    signal: AbortSignal,
    url: (value: string) => void = () => {},
  ) => {
    const status = await cursorAuthInHost(method, {
      signal,
      loginUrl: url,
      environmentKeyPresent: () => instance.id === "environment",
      credentialFileAbsent: () => credentialAbsent(file(instance)),
      sdk: {
        Cursor: {
          auth: {
            async login(options) {
              options?.onLoginUrl?.("https://cursor.com/login?challenge=sentinel-challenge");
              browser.resolve();
              await authorize.promise;
              options?.signal?.throwIfAborted();
              await mkdir(join(instance.homeDir, "user", ".cursor", "sdk"), { recursive: true });
              await writeFile(file(instance), "sentinel-secret");
              return { apiKey: "sentinel-secret", apiKeyExpiresAtMs: 999999 };
            },
            async status() {
              return (await credentialAbsent(file(instance)))
                ? { status: "logged-out" }
                : { status: "logged-in", backendUrl: "https://api.cursor.com" };
            },
            async logout() {
              await rm(file(instance), { force: true });
            },
          },
        },
      },
    });
    registry.setCursorSdkAuth(instance.id, status);
    return status;
  };
  const auth = new CursorAuthService({
    registry,
    now: () => 100,
    id: () => "login-a",
    createInstance: async (id, label) =>
      createInstance({ id, label, provider: "cursor", homeDir: join(root, id) }),
    rebindInstance: async () => {},
    setTimer(callback) {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
    driver: {
      login: (instance, signal, url) => operate("login", instance, signal, url),
      status: (instance, signal) => operate("status", instance, signal),
      logout: (instance, signal) => operate("logout", instance, signal),
    },
  });
  const f = await fixture({ cursorAuth: auth });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "cursor.auth.start", requestId: "start", instanceId: "a", label: "Work" });
    expect(await client.next()).toMatchObject({
      type: "cursor.auth.login",
      loginId: "login-a",
      state: "starting",
    });
    await browser.promise;
    client.send({ type: "cursor.auth.poll", requestId: "poll", loginId: "login-a" });
    expect(await client.next()).toMatchObject({
      state: "browser",
      url: "https://cursor.com/login?challenge=sentinel-challenge",
    });
    const other = await f.open();
    other.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("another-device"),
      token: "a".repeat(64),
    });
    await other.next();
    other.send({ type: "cursor.auth.poll", requestId: "forbidden", loginId: "login-a" });
    expect(await other.next()).toEqual({
      type: "cursor.auth.error",
      requestId: "forbidden",
      code: "forbidden",
    });
    authorize.resolve();
    let event: CursorAuthEvent | undefined;
    do {
      client.send({ type: "cursor.auth.poll", requestId: "finish", loginId: "login-a" });
      const value = await client.next();
      if (value.type === "cursor.auth.login") event = value;
      else throw new Error("Expected login response");
    } while (event.state === "starting" || event.state === "browser");
    expect(event).toMatchObject({
      state: "complete",
      auth: { status: "logged-in", source: "sdk-store" },
    });
    expect(event).not.toHaveProperty("url");
    expect(JSON.stringify(event)).not.toContain("sentinel-secret");
    client.send({ type: "cursor.auth.select", requestId: "select", instanceId: "a" });
    expect(await client.next()).toMatchObject({
      type: "cursor.auth.changed",
      selectedInstanceId: "a",
    });
    const instance = registry.get("a")?.instance;
    if (!instance) throw new Error("Missing registered account");
    const history = join(instance.homeDir, "user", ".cursor", "sdk", "history-sentinel");
    await writeFile(history, "preserved");
    client.send({ type: "cursor.auth.logout", requestId: "logout", instanceId: "a" });
    expect(await client.next()).toMatchObject({
      selectedInstanceId: null,
      auth: { status: "logged-out", source: "none" },
    });
    expect(await credentialAbsent(file(instance))).toBe(true);
    expect(await readFile(history, "utf8")).toBe("preserved");
    await registry.register(
      createInstance({
        id: "environment",
        provider: "cursor",
        homeDir: join(root, "environment"),
        label: "Environment",
      }),
    );
    client.send({ type: "cursor.auth.logout", requestId: "env", instanceId: "environment" });
    expect(await client.next()).toMatchObject({
      auth: { status: "logged-in", source: "environment" },
    });
    expect((await readFile(join(root, "accounts.sqlite"))).toString("utf8")).not.toContain(
      "sentinel-secret",
    );
    expect(
      f.store.atomic(
        (db) =>
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM events WHERE payload LIKE '%sentinel-challenge%'",
            )
            .get()?.count,
      ),
    ).toBe(0);
  } finally {
    authorize.resolve();
    await auth.close();
    await f.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
