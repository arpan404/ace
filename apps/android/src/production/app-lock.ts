/**
 * Production app lock policy for Android.
 *
 * Mirrors the iOS `AppLock` rules (`apps/ios/Sources/Models/AppLock.swift`)
 * without copying it: locked on launch when enabled, re-lock after the app
 * stays in the background past `timeout`, first pairing enables the lock
 * unless the person already chose, turning it off requires device
 * authentication first, and nothing is read or connected until unlock.
 * Biometrics stay behind an injected `authenticate` so lock rules test
 * without a device; production passes `expo-local-authentication`.
 */

/** Settings › App lock offers these, in seconds; zero locks on background. */
export const APP_LOCK_TIMEOUTS = [0, 60, 300, 900, 3600] as const;
export type AppLockTimeout = (typeof APP_LOCK_TIMEOUTS)[number];

/** Human label for the lock-timeout picker; matches the iOS `AppLockView.label`. */
export function formatAppLockTimeout(seconds: number): string {
  if (seconds === 0) return "Immediately";
  if (seconds === 60) return "After 1 minute";
  if (seconds === 300) return "After 5 minutes";
  if (seconds === 900) return "After 15 minutes";
  if (seconds === 3600) return "After 1 hour";
  return `After ${seconds} seconds`;
}

export type AuthenticationOutcome = "success" | "failed" | "unavailable";

export interface AppLockStorage {
  readEnabled(): boolean | undefined;
  readTimeout(): number | undefined;
  writeEnabled(enabled: boolean): void;
  writeTimeout(timeout: number): void;
  /** Best-effort flush when the store serializes writes; rejects when the last write failed. */
  flush?(): Promise<void>;
}

export interface AppLockDeps {
  enabled: boolean;
  timeout?: AppLockTimeout | undefined;
  now?: (() => number) | undefined;
  authenticate?: ((reason: string) => Promise<AuthenticationOutcome>) | undefined;
  storage?: AppLockStorage | undefined;
}

export interface AppLock {
  readonly locked: boolean;
  readonly authenticating: boolean;
  readonly failed: boolean;
  readonly enabled: boolean;
  readonly timeout: number;
  /** The first pairing turns the lock on, unless the person already chose. */
  enable(): void;
  /** On at once; off only after the device owner authenticates. */
  setEnabled(on: boolean): Promise<boolean>;
  setTimeout(seconds: number): void;
  /** Await serialized lock writes; rejects when the last write failed to persist. */
  persisted(): Promise<void>;
  didEnterBackground(): void;
  didBecomeActive(): void;
  unlock(): Promise<void>;
}

export function createAppLock(deps: AppLockDeps): AppLock {
  const now = deps.now ?? (() => Date.now());
  const authenticate = deps.authenticate ?? (async () => "unavailable" as const);
  const storage = deps.storage;
  const storedEnabled = storage?.readEnabled();
  // A choice the person made wins over the paired-or-not default.
  let enabled = storedEnabled ?? deps.enabled;
  const storedTimeout = storage?.readTimeout();
  let timeout: number =
    storedTimeout !== undefined && (APP_LOCK_TIMEOUTS as readonly number[]).includes(storedTimeout)
      ? storedTimeout
      : (deps.timeout ?? 60);
  let locked = enabled;
  let authenticating = false;
  let failed = false;
  let backgroundedAt: number | undefined;

  const snapshot = (): AppLock => ({
    get locked() {
      return locked;
    },
    get authenticating() {
      return authenticating;
    },
    get failed() {
      return failed;
    },
    get enabled() {
      return enabled;
    },
    get timeout() {
      return timeout;
    },
    enable() {
      if (storage?.readEnabled() !== undefined) return;
      enabled = true;
      storage?.writeEnabled(true);
    },
    async setEnabled(on: boolean): Promise<boolean> {
      if (!on && enabled) {
        if (authenticating) return enabled;
        authenticating = true;
        try {
          const outcome = await authenticate("Turn off the app lock");
          if (outcome === "failed") return enabled;
        } finally {
          authenticating = false;
        }
      }
      enabled = on;
      if (!on) locked = false;
      storage?.writeEnabled(on);
      return enabled;
    },
    setTimeout(seconds: number) {
      if (!(APP_LOCK_TIMEOUTS as readonly number[]).includes(seconds)) return;
      timeout = seconds;
      storage?.writeTimeout(seconds);
    },
    async persisted() {
      await storage?.flush?.();
    },
    didEnterBackground() {
      if (backgroundedAt === undefined) backgroundedAt = now();
    },
    didBecomeActive() {
      const since = backgroundedAt;
      backgroundedAt = undefined;
      if (!enabled || locked || since === undefined) return;
      if (now() - since >= timeout * 1000) {
        locked = true;
        failed = false;
      }
    },
    async unlock() {
      if (!locked || authenticating) return;
      authenticating = true;
      try {
        switch (await authenticate("Unlock your paired machines")) {
          case "success":
          case "unavailable":
            locked = false;
            failed = false;
            break;
          case "failed":
            failed = true;
            break;
        }
      } finally {
        authenticating = false;
      }
    },
  });
  return snapshot();
}
