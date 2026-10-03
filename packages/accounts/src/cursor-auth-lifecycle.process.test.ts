import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { CursorAuthService, openRegistry, createInstance, cursorSdkLoginDriver } from "./index.ts";

const loggedOut = async () => ({ status: "logged-out", source: "none" }) as const;

it.each([
  "cursor.auth.status",
  "cursor.auth.select",
  "cursor.auth.logout",
  "cursor.auth.start",
] as const)("%s reports a missing SDK backend before admitting authentication", async (type) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-auth-unavailable-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const service = new CursorAuthService({
    registry,
    now: () => 1,
    id: () => "login-job",
    setTimer: () => () => {},
    createInstance: async (id, label) =>
      createInstance({ id, label, provider: "cursor", homeDir: join(root, id) }),
    rebindInstance: async () => {},
    driver: cursorSdkLoginDriver(registry, {
      now: () => 1,
      launchEnv: {},
      stopInstance: async () => {},
      discovery: {
        resolve() {
          throw Object.assign(new Error("Synthetic SDK missing"), { code: "MODULE_NOT_FOUND" });
        },
      },
    }),
  });
  try {
    // Login creates a fresh instance; the other operations use an existing private home.
    if (type !== "cursor.auth.start")
      await registry.register(
        createInstance({ id: "a", provider: "cursor", label: "A", homeDir: join(root, "a") }),
      );
    expect(
      await service.handle("device-a", { type, requestId: "request", instanceId: "a" }),
    ).toEqual({
      type: "cursor.auth.error",
      requestId: "request",
      code: "unavailable",
      reason: "sdk_unavailable",
    });
    expect(registry.selectedCursorSdk()).toBeUndefined();
    expect(registry.summary("a", 1)?.quota.cursorSdkAuth).toBeUndefined();
  } finally {
    await service.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("a logged-out Cursor account fails selection while another provider is unavailable for Cursor auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-auth-selection-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const service = new CursorAuthService({
    registry,
    now: () => 1,
    id: () => "login-job",
    setTimer: () => () => {},
    createInstance: async (id, label) =>
      createInstance({ id, label, provider: "cursor", homeDir: join(root, id) }),
    rebindInstance: async () => {},
    driver: { status: loggedOut, login: loggedOut, logout: loggedOut },
  });
  try {
    for (const provider of ["cursor", "codex"] as const)
      await registry.register(
        createInstance({ id: provider, provider, label: provider, homeDir: join(root, provider) }),
      );
    expect(
      await service.handle("device-a", {
        type: "cursor.auth.status",
        requestId: "status",
        instanceId: "cursor",
      }),
    ).toMatchObject({
      type: "cursor.auth.changed",
      auth: { status: "logged-out", source: "none" },
    });
    expect(
      await service.handle("device-a", {
        type: "cursor.auth.select",
        requestId: "select",
        instanceId: "cursor",
      }),
    ).toEqual({ type: "cursor.auth.error", requestId: "select", code: "auth_failed" });
    for (const type of [
      "cursor.auth.status",
      "cursor.auth.select",
      "cursor.auth.logout",
      "cursor.auth.start",
    ] as const)
      expect(
        await service.handle("device-a", { type, requestId: "other", instanceId: "codex" }),
      ).toEqual({
        type: "cursor.auth.error",
        requestId: "other",
        code: "unavailable",
        reason: "instance_unavailable",
      });
    expect(registry.selectedCursorSdk()).toBeUndefined();
    await service.close();
    expect(
      await service.handle("device-a", {
        type: "cursor.auth.status",
        requestId: "closed",
        instanceId: "cursor",
      }),
    ).toEqual({
      type: "cursor.auth.error",
      requestId: "closed",
      code: "unavailable",
      reason: "service_unavailable",
    });
  } finally {
    await service.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("sign-out cancels the selected browser exchange before deletion and expiration clears its challenge", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-auth-lifecycle-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const started = Promise.withResolvers<void>();
  const outcomes: string[] = [];
  let expire: (() => void) | undefined;
  let sequence = 0;
  const service = new CursorAuthService({
    registry,
    now: () => 1,
    id: () => `job-${++sequence}`,
    createInstance: async (id, label) =>
      createInstance({ id, label, provider: "cursor", homeDir: join(root, id) }),
    rebindInstance: async () => {},
    setTimer(callback) {
      expire = callback;
      return () => {};
    },
    driver: {
      async login(_instance, signal, url) {
        url("https://cursor.com/login?challenge=synthetic");
        started.resolve();
        const cancelled = new Promise<never>((_resolve, reject) => {
          const abort = () => {
            outcomes.push("login host exited");
            reject(new Error("cancelled"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        return cancelled;
      },
      async status() {
        return { status: "logged-out", source: "none" };
      },
      async logout() {
        outcomes.push("credential removed");
        return { status: "logged-out", source: "none" };
      },
    },
  });
  try {
    const start = await service.handle("device-a", {
      type: "cursor.auth.start",
      requestId: "start",
      instanceId: "a",
    });
    expect(start).toMatchObject({ loginId: "job-1" });
    await started.promise;
    const duplicate = await service.handle("device-a", {
      type: "cursor.auth.start",
      requestId: "start",
      instanceId: "a",
    });
    expect(duplicate).toMatchObject({ loginId: "job-1", state: "browser" });
    expect(
      await service.handle("device-a", {
        type: "cursor.auth.logout",
        requestId: "out",
        instanceId: "a",
      }),
    ).toMatchObject({ auth: { source: "none" } });
    expect(outcomes).toEqual(["login host exited", "credential removed"]);
    const cancelled = await service.handle("device-a", {
      type: "cursor.auth.poll",
      requestId: "poll",
      loginId: "job-1",
    });
    expect(cancelled).toMatchObject({ state: "cancelled" });
    expect(cancelled).not.toHaveProperty("url");
    await service.handle("device-a", {
      type: "cursor.auth.start",
      requestId: "again",
      instanceId: "a",
    });
    if (!expire) throw new Error("Missing expiry callback");
    expire();
    const expired = await service.handle("device-a", {
      type: "cursor.auth.poll",
      requestId: "expired",
      loginId: "job-2",
    });
    if (expired.type === "cursor.auth.login") expect(expired.state).toBe("cancelled");
    else expect(expired).toMatchObject({ type: "cursor.auth.error", code: "not_found" });
    expect(expired).not.toHaveProperty("url");
  } finally {
    await service.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps the selected account across registry restart without moving another account home", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-selected-"));
  let registry = await openRegistry(join(root, "accounts.sqlite"));
  try {
    for (const id of ["a", "b"])
      await registry.register(
        createInstance({ id, provider: "cursor", label: id, homeDir: join(root, id) }),
      );
    const originalHome = registry.get("a")?.instance.homeDir;
    registry.selectCursorSdk("a");
    registry.close();
    registry = await openRegistry(join(root, "accounts.sqlite"));
    expect(registry.selectedCursorSdk()).toBe("a");
    registry.selectCursorSdk("b");
    expect(registry.get("a")?.instance.homeDir).toBe(originalHome);
    expect(registry.selectedCursorSdk()).toBe("b");
    expect(() => registry.selectCursorSdk("unknown")).toThrow("Unknown Cursor instance");
    expect(registry.selectedCursorSdk()).toBe("b");
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
