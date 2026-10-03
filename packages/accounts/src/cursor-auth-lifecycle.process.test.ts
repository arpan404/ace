import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { CursorAuthService, openRegistry, createInstance } from "./index.ts";

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
