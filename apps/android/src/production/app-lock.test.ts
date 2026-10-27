import { expect, it } from "vitest";
import {
  createAppLock,
  formatAppLockTimeout,
  type AppLockStorage,
  type AuthenticationOutcome,
} from "./app-lock.ts";

function memoryStorage(initial?: {
  enabled?: boolean | undefined;
  timeout?: number | undefined;
}): AppLockStorage & { writes: { enabled: boolean[]; timeout: number[] } } {
  let enabled = initial?.enabled;
  let timeout = initial?.timeout;
  const writes = { enabled: [] as boolean[], timeout: [] as number[] };
  return {
    writes,
    readEnabled: () => enabled,
    readTimeout: () => timeout,
    writeEnabled: (next) => {
      enabled = next;
      writes.enabled.push(next);
    },
    writeTimeout: (next) => {
      timeout = next;
      writes.timeout.push(next);
    },
  };
}

it("locks on launch when enabled and stays open when disabled", () => {
  expect(createAppLock({ enabled: true }).locked).toBe(true);
  expect(createAppLock({ enabled: false }).locked).toBe(false);
});

it("a stored choice wins over the paired-or-not default", () => {
  expect(createAppLock({ enabled: true, storage: memoryStorage({ enabled: false }) }).enabled).toBe(
    false,
  );
  expect(createAppLock({ enabled: false, storage: memoryStorage({ enabled: true }) }).locked).toBe(
    true,
  );
});

it("first pairing enables the lock unless the person already chose", () => {
  const fresh = createAppLock({ enabled: false, storage: memoryStorage() });
  fresh.enable();
  expect(fresh.enabled).toBe(true);

  const chosen = createAppLock({ enabled: false, storage: memoryStorage({ enabled: false }) });
  chosen.enable();
  expect(chosen.enabled).toBe(false);
});

it("enabling the lock persists the choice for the next launch", () => {
  const storage = memoryStorage();
  const fresh = createAppLock({ enabled: false, storage });
  fresh.enable();
  expect(storage.writes.enabled).toEqual([true]);

  const chosen = createAppLock({ enabled: false, storage: memoryStorage({ enabled: false }) });
  const before = chosen.enabled;
  chosen.enable();
  expect(chosen.enabled).toBe(before);
});

it("turning the lock off requires authentication", async () => {
  let calls = 0;
  const denied = createAppLock({
    enabled: true,
    authenticate: async () => {
      calls += 1;
      return "failed";
    },
    storage: memoryStorage(),
  });
  expect(await denied.setEnabled(false)).toBe(true);
  expect(denied.enabled).toBe(true);
  expect(denied.locked).toBe(true);
  expect(calls).toBe(1);

  const allowed = createAppLock({
    enabled: true,
    authenticate: async () => "success",
    storage: memoryStorage(),
  });
  expect(await allowed.setEnabled(false)).toBe(false);
  expect(allowed.locked).toBe(false);
});

it("turning the lock off without a device credential opens directly", async () => {
  const storage = memoryStorage();
  const noPasscode = createAppLock({
    enabled: true,
    authenticate: async () => "unavailable" as AuthenticationOutcome,
    storage,
  });
  expect(await noPasscode.setEnabled(false)).toBe(false);
  expect(noPasscode.enabled).toBe(false);
  expect(noPasscode.locked).toBe(false);
  expect(storage.writes.enabled).toEqual([false]);
});

it("background timeout applies while unlocked and resets the failure flag", async () => {
  let at = 1_000;
  const lock = createAppLock({
    enabled: true,
    timeout: 60,
    now: () => at,
    authenticate: async () => "success" as AuthenticationOutcome,
  });
  await lock.unlock();
  expect(lock.locked).toBe(false);
  lock.didEnterBackground();
  at += 30_000;
  lock.didBecomeActive();
  expect(lock.locked).toBe(false);
  lock.didEnterBackground();
  at += 61_000;
  lock.didBecomeActive();
  expect(lock.locked).toBe(true);
  expect(lock.failed).toBe(false);
});

it("zero timeout locks on the next foreground", async () => {
  let at = 1_000;
  const lock = createAppLock({
    enabled: true,
    timeout: 0,
    now: () => at,
    authenticate: async () => "success" as AuthenticationOutcome,
  });
  await lock.unlock();
  lock.didEnterBackground();
  lock.didBecomeActive();
  expect(lock.locked).toBe(true);
});

it("unlock success and unavailable open, failure stays shut", async () => {
  const ok = createAppLock({ enabled: true, authenticate: async () => "success" });
  await ok.unlock();
  expect(ok.locked).toBe(false);

  const noPasscode = createAppLock({ enabled: true, authenticate: async () => "unavailable" });
  await noPasscode.unlock();
  expect(noPasscode.locked).toBe(false);

  const bad = createAppLock({ enabled: true, authenticate: async () => "failed" });
  await bad.unlock();
  expect(bad.locked).toBe(true);
  expect(bad.failed).toBe(true);
});

it("labels every offered timeout for the settings picker", () => {
  expect(formatAppLockTimeout(0)).toBe("Immediately");
  expect(formatAppLockTimeout(60)).toBe("After 1 minute");
  expect(formatAppLockTimeout(300)).toBe("After 5 minutes");
  expect(formatAppLockTimeout(900)).toBe("After 15 minutes");
  expect(formatAppLockTimeout(3600)).toBe("After 1 hour");
});

it("ignores unknown stored timeouts and rejected timeout values", () => {
  const stored = createAppLock({
    enabled: true,
    storage: memoryStorage({ timeout: 123 }),
  });
  expect(stored.timeout).toBe(60);
  stored.setTimeout(45);
  expect(stored.timeout).toBe(60);
  stored.setTimeout(300);
  expect(stored.timeout).toBe(300);
});

it("persisted surfaces a failed lock save instead of silently claiming success", async () => {
  const failing = createAppLock({
    enabled: true,
    storage: {
      ...memoryStorage(),
      flush: async () => {
        throw new Error("The app-lock choice could not be saved.");
      },
    },
  });
  await expect(failing.persisted()).rejects.toThrow("could not be saved");
  const flushing = createAppLock({
    enabled: true,
    storage: { ...memoryStorage(), flush: async () => undefined },
  });
  await expect(flushing.persisted()).resolves.toBeUndefined();
  const plain = createAppLock({ enabled: true, storage: memoryStorage() });
  await expect(plain.persisted()).resolves.toBeUndefined();
});
