import { useEffect, useRef, useState } from "react";
import { AppState, View, type AppStateStatus } from "react-native";
import { requireNativeModule } from "expo";
import * as LocalAuthentication from "expo-local-authentication";
import { SecurityLevel } from "expo-local-authentication";
import * as Network from "expo-network";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { AceText, AceButton, Column, Group } from "../components.tsx";
import { tokens, useTheme } from "../theme.tsx";
import { expoBridgeFromModule } from "../security/expo-bridge.ts";
import { createProductionCredentialStore } from "../pairing/secure-store.ts";
import { ensureOutboxTables, sqliteNamespace } from "../storage.ts";
import {
  createProductionStartup,
  sqliteStartupDatabase,
  ViewOnlyError,
  type ProductionStartup,
} from "../runtime/production-startup.ts";
import {
  APP_LOCK_TIMEOUTS,
  createAppLock,
  formatAppLockTimeout,
  type AppLock,
  type AppLockTimeout,
} from "./app-lock.ts";
import { deviceAuthenticate } from "./device-auth.ts";
import { isSecureWindowApplied } from "./secure-window.ts";
import {
  resolveSecureScreenEnabled,
  setSecureScreenEnabledAsync,
  type SecureNative,
} from "../settings/secureScreen.ts";
import { PRODUCTION_LOAD_TIMEOUT_MS, withLoadTimeout } from "./load-timeout.ts";
import { createLoadLifecycle } from "./load-lifecycle.ts";
import { createStartupTeardown } from "./startup-teardown.ts";
import { createCoalescingFlight } from "./single-flight.ts";
import { readStoredLockPrefsWithStatus, sqliteAppLockStorage } from "./lock-storage.ts";
import { networkChange, type NetworkSnapshot } from "./network-monitor.ts";
import { machineCards, routeMessage, selectActiveHost } from "./production-wiring.ts";
import { PairingScreen } from "../Pairing.tsx";
import { PairingFlowError, type ConfirmedPairing } from "../pairing/pairing-flow.ts";
import type { MachineEntry } from "@ace/client/machines";

/**
 * Production root: app lock, then pairing or the paired machines.
 *
 * Mirrors the iOS `RootView` lifecycle without copying it: nothing is read
 * or connected until the person unlocks (the directory load and the first
 * socket connect wait for `lock.locked == false`), the first pairing
 * enables the lock, backgrounding re-locks past the timeout and hides
 * content from the app switcher, and every machine routes to pairing or
 * stays per its own pin/grant/record. The pinned native bridge, the
 * Keystore credential store and the per-machine SQLite namespaces are the
 * only production path: when the bridge is missing the screen fails closed
 * and never touches the fixture runtime or the default fetch/WebSocket.
 *
 * Lock choice persistence: the on/off choice and timeout live in the
 * `ace-lock` metadata namespace of the same `ace-production.db`. A stored
 * choice wins over the default; with no stored choice the lock starts
 * enabled (fail closed: a migrated paired install without a stored flag
 * must not silently open, since the paired state cannot be read before
 * unlock). Fresh installs on phones with no device credential auto-open
 * like iOS; on secured phones the first launch asks once before pairing.
 *
 * Screen protection is the native window flag, set on the Activity before
 * the first frame by the single `with-ace-secure-screen` config plugin (the
 * same guard `ace/android-ios-parity` uses: no competing transforms). The old JS
 * screen-capture call ran after first render and swallowed its own failure,
 * so it is not a guard and is gone: startup verifies
 * `secureWindowApplied` on the native module and fails closed (no directory
 * read, no socket) when the flag is missing, so a build without the plugin
 * never shows paired content. `SecureScreenGuard` in the native module
 * re-applies the desired state across Activity recreation; the prebuild
 * transform is covered by `src/secure-screen-plugin.test.ts` because the
 * generated `android/` tree is gitignored.
 *
 * Secure-screen toggling: the native default is secure (fail-closed from
 * `MainActivity.onCreate`), and JS relaxes it only once the durable lock
 * choice is loaded — `resolveSecureScreenEnabled` keeps the window guarded
 * until settings load and follows the stored choice after. The toggle is
 * best-effort (`setSecureScreenEnabled` never throws); a missing bridge or
 * a null activity leaves the fail-closed default in place. The startup
 * `secureWindowApplied` verification below stays: it gates content on the
 * first-frame flag, while the toggle tracks the lock choice afterwards.
 *
 * Parity integration: this root reuses the parity-owned shared pieces
 * (same native guard `with-ace-secure-screen` + `SecureScreenGuard`, the
 * secure-screen toggle in `settings/secureScreen.ts` with the async honest
 * setter, and the full pairing screen `src/Pairing.tsx` with QR scan).
 * No duplicate plugin, guard, or pairing screen is introduced here.
 * `production/app-lock.ts` is complementary, not duplicated: it owns the
 * stateful policy (`createAppLock` locked/background/timeout state plus
 * `persisted()` flush surfacing) while `settings/appLock.ts` owns the pure
 * decisions; the fixture `App.tsx` keeps its own pure-helper lock gate.
 * This root keeps the reviewed wiring (the generation-guarded retry, the
 * single-flight redeem and the `ProductionRoot` lifecycle).
 *
 * Settings (the Machines screen) expose the persisted lock choice: on/off
 * (turning off asks for device authentication first, like iOS) and the
 * lock-after timeout. Both write through the same `createAppLock` policy
 * the startup gate reads; there is no second lock implementation.
 *
 * Inbox threads arrive with the multi-machine merge (later): this slice
 * owns startup, pairing, lock/privacy and per-machine permission display.
 * Mutations stay behind `startup.runtimeForMutation(hostId)` (the reviewed
 * gate); screens resolve it per operation and never cache it.
 */

async function productionAuthenticate(
  reason: string,
): Promise<"success" | "failed" | "unavailable"> {
  return deviceAuthenticate(reason, {
    enrolledLevel: async () => {
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      // Only a phone with no passcode at all opens without auth. A device
      // passcode without enrolled biometrics still authenticates (unlike
      // `isEnrolledAsync`, which reports biometrics only).
      return level === SecurityLevel.NONE ? "none" : "device";
    },
    authenticate: async (promptMessage) => {
      // Defaults: explicit confirmation required, device-passcode fallback
      // enabled — the `deviceOwnerAuthentication` equivalent.
      const result = await LocalAuthentication.authenticateAsync({ promptMessage });
      return result.success;
    },
  });
}

function networkSnapshot(state: {
  isConnected?: boolean | undefined;
  type?: unknown;
}): NetworkSnapshot {
  return {
    online: state.isConnected ?? false,
    iface: typeof state.type === "string" ? state.type : "unknown",
  };
}

export function ProductionRoot({ notify }: { notify: (text: string) => void }) {
  const theme = useTheme();
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [startup, setStartup] = useState<ProductionStartup | null>(null);
  const [lock, setLock] = useState<AppLock | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [, setEntriesVersion] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [secureGuardFailed, setSecureGuardFailed] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [activeHost, setActiveHost] = useState<string | undefined>(undefined);
  const [, setTick] = useState(0);
  const lockRef = useRef<AppLock | null>(null);
  const startupRef = useRef<ProductionStartup | null>(null);
  const backgroundedRef = useRef(false);
  const previousNetworkRef = useRef<NetworkSnapshot | undefined>(undefined);
  const loadingRef = useRef(false);
  const loadOwnerRef = useRef(createLoadLifecycle());
  const [lockStorageFailed, setLockStorageFailed] = useState(false);

  // Phase one: bridge, native screen guard, database, lock prefs and startup
  // object only. The directory, the credentials and the sockets stay
  // untouched until unlock. `startupAttempt` re-runs this phase after a
  // startup failure retry. Each attempt is one ownership generation: a fresh
  // load owner, one startup manager, one database handle and one ordered
  // teardown (drain → disconnect → flush → close). The teardown is the
  // single unmount path for its generation, so a late load can never open
  // runtimes after its own cleanup closed the database, and a retried
  // generation disconnects its own (old) manager instead of leaking it.
  //
  // Phase-one work is tracked on the same owner the teardown drains: the raw
  // SQLite open, the table creation and the lock-prefs read are all
  // registered before they are raced against the load timeout. A timeout
  // therefore never closes the database while tracked work still runs — the
  // failure path runs the ordered teardown, which drains the orphans first
  // and closes last. Nothing here claims native cancellation: a timed-out
  // open still resolves later (the orphan hook closes that late handle) and
  // a timed-out table/prefs orphan still settles before the close.
  useEffect(() => {
    let cancelled = false;
    const owner = createLoadLifecycle();
    loadOwnerRef.current = owner;
    // A new phase-one generation owns a fresh load: drop the previous
    // generation's gated-load state so a retry never inherits a stale
    // `loading` latch or a stale `loaded`/`loadError` verdict.
    loadingRef.current = false;
    setLoaded(false);
    setLoadError(null);
    let db: SQLiteDatabase | null = null;
    let seen: ProductionStartup | null = null;
    let storage: { flush(): Promise<void> } | null = null;
    let networkSubscription: { remove(): void } | null = null;
    let dbClosed = false;
    const closeDbOnce = async (): Promise<void> => {
      if (dbClosed) return;
      dbClosed = true;
      const handle = db;
      db = null;
      await handle?.closeAsync().catch(() => undefined);
    };
    const teardown = createStartupTeardown({
      owner,
      disconnectAll: async () => {
        await seen?.disconnectAll();
      },
      flush: async () => {
        await storage?.flush();
      },
      closeDb: closeDbOnce,
    });
    void (async () => {
      let bridge;
      let nativeModule: unknown = null;
      try {
        nativeModule = requireNativeModule("AceNative");
        bridge = expoBridgeFromModule(nativeModule);
      } catch {
        if (!cancelled) setFailure("This build cannot pair yet: the pinned bridge is missing.");
        return;
      }
      // Native FLAG_SECURE must already be on the window before the first
      // frame. Fail closed when the guard (or the whole native module entry)
      // is unavailable: no database, no directory, no socket.
      if (!isSecureWindowApplied(nativeModule)) {
        if (!cancelled) setFailure("This build cannot protect the screen, so it stays closed.");
        return;
      }
      try {
        // The timeout only surfaces Retry: it cannot cancel the SQLite open,
        // so a late handle is closed by the orphan hook instead of leaking.
        // The hook closes the orphaned value; `closeDbOnce` guards the
        // adopted handle, so the two can never double-close. The raw open is
        // tracked so the generation teardown drains a late resolve before
        // its final close.
        const openRaw = openDatabaseAsync("ace-production.db");
        owner.track(openRaw);
        db = await withLoadTimeout(openRaw, PRODUCTION_LOAD_TIMEOUT_MS, (outcome) => {
          if (outcome.settled === "resolved")
            void outcome.value.closeAsync().catch(() => undefined);
        });
        if (cancelled) return;
        // Table creation only; no directory, credential or grant rows read.
        // Tracked like the open: the failure teardown below drains this
        // orphan before closing, instead of closing under a running DDL.
        const ensureRaw = ensureOutboxTables(db);
        owner.track(ensureRaw);
        await withLoadTimeout(ensureRaw, PRODUCTION_LOAD_TIMEOUT_MS);
        if (cancelled) return;
        // The prefs read hangs opaque without a bound; race it like every
        // other phase-one load so a stuck query surfaces Retry. No orphan
        // resource to release — the database stays adopted until teardown.
        const prefsRaw = readStoredLockPrefsWithStatus(db);
        owner.track(prefsRaw);
        const { prefs, storageFailed } = await withLoadTimeout(
          prefsRaw,
          PRODUCTION_LOAD_TIMEOUT_MS,
        );
        if (cancelled) return;
        const produced = createProductionStartup({
          bridge,
          credentials: createProductionCredentialStore(),
          directoryStorage: sqliteNamespace(db, "ace-directory"),
          database: sqliteStartupDatabase(db),
        });
        const lockStorage = sqliteAppLockStorage(db, prefs);
        storage = lockStorage;
        const appLock = createAppLock({
          enabled: prefs.enabled ?? true,
          ...(prefs.timeout !== undefined &&
          (APP_LOCK_TIMEOUTS as readonly number[]).includes(prefs.timeout)
            ? { timeout: prefs.timeout as AppLockTimeout }
            : {}),
          authenticate: productionAuthenticate,
          storage: lockStorage,
        });
        seen = produced;
        startupRef.current = produced;
        lockRef.current = appLock;
        if (cancelled) return;
        setLockStorageFailed(storageFailed);
        setStartup(produced);
        setLock(appLock);
        try {
          previousNetworkRef.current = networkSnapshot(await Network.getNetworkStateAsync());
        } catch {
          previousNetworkRef.current = undefined;
        }
        if (!cancelled) {
          networkSubscription = Network.addNetworkStateListener((event) => {
            const next = networkSnapshot(event);
            const change = networkChange(previousNetworkRef.current, next);
            previousNetworkRef.current = next;
            if (change !== null)
              startupRef.current?.setOnline(change.online, change.interfaceChanged);
          });
        }
      } catch {
        // A failed phase one runs the same ordered teardown as unmount:
        // drain the tracked orphans first so a timed-out table/prefs write
        // settles before the close, then disconnect (no-op here), flush and
        // close last. Direct `closeDbOnce` here would close under a running
        // orphan. The effect cleanup below re-runs the same teardown and
        // shares the first run instead of double-closing. A failed lock
        // flush is no longer swallowed by the teardown: surface it as a
        // storage failure (inline banner) alongside the generic failure.
        if (!cancelled) {
          try {
            await teardown.teardown();
          } catch {
            setLockStorageFailed(true);
          }
          setFailure("The connection could not start.");
        }
        // When cancelled the effect cleanup owns the teardown; returning
        // lets it drain and close exactly once.
      }
    })();
    return () => {
      cancelled = true;
      networkSubscription?.remove();
      networkSubscription = null;
      // Single ordered teardown for this generation: drain tracked loads,
      // then disconnect its own manager, flush lock writes, close the
      // database last. Idempotent across retry cleanup and unmount. The
      // flush error is owned by the failure path above; unmount has no UI
      // left to report to, so it stays swallowed here.
      void teardown.teardown().catch(() => undefined);
    };
    // `startupAttempt` re-runs phase one after a startup retry; nothing else does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startupAttempt]);

  // Phase two: load the directory and connect, only once unlocked. Matches
  // iOS `RootView.task(id: lock.locked)`: while `locked`, no listing, no
  // credential read and no socket. `loadAttempt` re-runs this phase after a
  // load retry; the ref resets on failure so a retry can proceed.
  //
  // Generation safety: a timed-out attempt is never cancelled (no API can
  // stop it) and still reconciles into the shared manager when it eventually
  // runs — the reconcile is serialized and idempotent, so the retry queues
  // behind it instead of duplicating owners. A stale attempt must therefore
  // never write state and, critically, never `disconnectAll`: the manager is
  // shared within its generation, so a stale cleanup would tear down the
  // newer attempt's sockets. Only the current generation adopts results or
  // reports errors. Each phase-one generation owns a fresh lifecycle owner
  // (reset above), so a phase-one retry mints a new manager with a new owner
  // and the old generation's teardown drains and disconnects the old manager.
  //
  // Terminal disposal is the same ordered teardown: the phase-one cleanup is
  // the single unmount path per generation (drain → disconnect → flush →
  // close), so a late orphan finishes its pre-serialize steps before the
  // disconnect that closes what it opened.
  const locked = lock?.locked;
  useEffect(() => {
    if (!startup || !lock || lock.locked || loaded || loadingRef.current) return;
    loadingRef.current = true;
    const owner = loadOwnerRef.current;
    const generation = owner.begin();
    const isCurrent = () => owner.isCurrent(generation);
    let cancelled = false;
    // Track the underlying load, not the timeout race: the race settles
    // early while the orphan still runs, and the terminal drain must wait
    // for the orphan itself.
    const raw = startup.load();
    owner.track(raw);
    void (async () => {
      try {
        // A hung directory read must surface Retry: without the race the UI
        // sits on an opaque screen with no recovery.
        const entries = await withLoadTimeout(raw);
        if (cancelled || !isCurrent()) return;
        setActiveHost(selectActiveHost(entries));
        setEntriesVersion((v) => v + 1);
        setLoadError(null);
        setLoaded(true);
      } catch {
        if (cancelled || !isCurrent()) return;
        loadingRef.current = false;
        setLoadError("The connection could not start.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // `locked` (not the lock identity) re-fires this after each unlock; the
    // refs guard against double loads. `loadAttempt` re-fires after retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, lock, locked, loaded, loadAttempt]);

  // Secure-screen toggle tracks the durable lock choice. The native default
  // is secure, so before settings load (and when storage failed) nothing is
  // relaxed; once the choice is known the window follows it. The native call
  // may settle asynchronously: a rejection must surface the guarded banner
  // instead of reporting success, and a late settlement after unmount or a
  // newer choice must never write state. Fail-closed: the resolve helper
  // keeps the window guarded until the durable choice is known, and the
  // startup gate above already blocks content when the first-frame flag is
  // missing.
  const lockEnabled = lock?.enabled;
  const settingsReady = startup !== null && lock !== null;
  useEffect(() => {
    if (!settingsReady || lock === null) return;
    let cancelled = false;
    const desired = resolveSecureScreenEnabled({
      lockEnabled: lock.enabled,
      settingsLoaded: true,
      storageFailed: lockStorageFailed,
    });
    void setSecureScreenEnabledAsync(
      desired,
      () => requireNativeModule("AceNative") as SecureNative,
    ).then((applied) => {
      if (cancelled) return;
      setSecureGuardFailed(!applied);
      if (!applied)
        notify("Screen protection could not be confirmed. Content stays guarded until it applies.");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady, lockEnabled, lockStorageFailed]);

  // Single app-state subscription drives both the privacy cover (render) and
  // the lock/wake bookkeeping (event callback). Only a visit through the
  // background wakes the runtimes; an inactive→active hop must not.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") {
        backgroundedRef.current = true;
        lockRef.current?.didEnterBackground();
      } else if (next === "active") {
        lockRef.current?.didBecomeActive();
        if (backgroundedRef.current) {
          backgroundedRef.current = false;
          startupRef.current?.wake();
        }
      }
      setAppState(next);
    });
    return () => subscription.remove();
  }, []);

  if (failure) {
    return (
      <Center>
        <Column>
          <AceText role="body">{failure}</AceText>
          <AceButton
            label="Retry"
            onPress={() => {
              setFailure(null);
              setStartupAttempt((v) => v + 1);
            }}
          />
        </Column>
      </Center>
    );
  }
  if (!startup || !lock) {
    // Opaque before the lock resolves: no paired content can flash, even on
    // a first frame that reports `active`.
    return (
      <Center>
        <AceText role="body">Opening ace…</AceText>
      </Center>
    );
  }
  // Privacy cover: hide paired content from the app switcher snapshot.
  if (appState !== "active") {
    return <View style={{ flex: 1, backgroundColor: theme.colours.background }} />;
  }
  if (lock.locked) {
    return <LockScreen lock={lock} refresh={() => setTick((v) => v + 1)} />;
  }
  if (loadError) {
    // Gated load failed after unlock: nothing was connected, so retrying the
    // read is safe and stays behind the same unlock gate.
    return (
      <Center>
        <Column>
          <AceText role="body">{loadError}</AceText>
          <AceButton
            label="Retry"
            onPress={() => {
              setLoadError(null);
              loadingRef.current = false;
              setLoadAttempt((v) => v + 1);
            }}
          />
        </Column>
      </Center>
    );
  }
  if (!loaded) {
    // Unlocked but the directory has not been read yet: stay opaque until
    // the gated load completes.
    return <View style={{ flex: 1, backgroundColor: theme.colours.background }} />;
  }
  return (
    <MachinesView
      startup={startup}
      lock={lock}
      activeHost={activeHost}
      pairingOpen={pairingOpen}
      secureGuardFailed={secureGuardFailed}
      lockStorageFailed={lockStorageFailed}
      onPairingOpen={() => setPairingOpen(true)}
      onPairingClose={() => setPairingOpen(false)}
      onChanged={(entries) => {
        setActiveHost((prev) => selectActiveHost(entries, prev ?? activeHost));
        setEntriesVersion((v) => v + 1);
      }}
      onSelect={setActiveHost}
      notify={notify}
    />
  );
}

function Center({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        padding: tokens.spacing.xl,
        backgroundColor: theme.colours.background,
      }}
    >
      {children}
    </View>
  );
}

function LockScreen({ lock, refresh }: { lock: AppLock; refresh(): void }) {
  const [busy, setBusy] = useState(false);
  async function unlock() {
    if (busy) return;
    setBusy(true);
    try {
      await lock.unlock();
    } finally {
      setBusy(false);
      refresh();
    }
  }
  const prompted = useRef(false);
  useEffect(() => {
    // Prompt once on mount, like iOS `LockView.task { await lock.unlock() }`.
    if (prompted.current) return;
    prompted.current = true;
    void lock.unlock().finally(() => refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Center>
      <Column>
        <AceText role="title">ace is locked</AceText>
        {lock.failed ? <AceText role="caption">Couldn&apos;t verify it&apos;s you.</AceText> : null}
        <AceButton label="Unlock" onPress={() => void unlock()} />
      </Column>
    </Center>
  );
}

function MachinesView({
  startup,
  lock,
  activeHost,
  pairingOpen,
  secureGuardFailed,
  lockStorageFailed,
  onPairingOpen,
  onPairingClose,
  onChanged,
  onSelect,
  notify,
}: {
  startup: ProductionStartup;
  lock: AppLock;
  activeHost: string | undefined;
  pairingOpen: boolean;
  secureGuardFailed: boolean;
  lockStorageFailed: boolean;
  onPairingOpen(): void;
  onPairingClose(): void;
  onChanged(entries: readonly MachineEntry[]): void;
  onSelect(hostId: string): void;
  notify(text: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Coalescing same-tick redeem: `busy` state flushes async, so two presses
  // in one tick would both redeem the single-use code. The flight is claimed
  // synchronously: a same-request double-tap (same link code plus the
  // trimmed device name — redeem trims, so whitespace variants are the same
  // request and must share, not reject) shares the in-flight promise
  // instead of throwing, while a *different* pairing request (different link
  // code) rejects with a typed `PairingFlowError` instead of resolving to
  // the wrong host. The trailing AbortSignal never participates in the key:
  // a second caller's abort rejects only its own waiter. The redeem itself
  // is bounded by the production load timeout so a hung transport cannot
  // block the flight forever; the timeout frees the flight but cannot cancel
  // the orphaned redeem (no native cancellation), which still runs on and
  // may still save — a retry can then hit the duplicate path. The daemon
  // still rejects reuse as the security boundary.
  const pairFlightRef = useRef<
    | ((
        // eslint-disable-next-line no-unused-vars
        confirmed: ConfirmedPairing,
        // eslint-disable-next-line no-unused-vars
        deviceName: string,
        // eslint-disable-next-line no-unused-vars
        signal?: AbortSignal,
      ) => Promise<MachineEntry>)
    | null
  >(null);
  const entries = startup.manager.entries();
  const cards = machineCards({
    entries,
    canOperate: (hostId) => startup.canOperate(hostId),
    route: (hostId) => startup.route(hostId),
  });

  async function pair(confirmed: ConfirmedPairing, deviceName: string, signal?: AbortSignal) {
    // Lazily bind the coalescing flight so the duplicate-press rule is the
    // same helper the unit tests drive (not a local mock): one redeem per
    // flight, same-request duplicates share silently, distinct requests
    // reject with a typed pairing error instead of pairing the wrong host.
    if (pairFlightRef.current === null) {
      pairFlightRef.current = createCoalescingFlight(
        async (inner: ConfirmedPairing, name: string, innerSignal?: AbortSignal) => {
          setBusy(true);
          setError(null);
          try {
            // Bound so a hung transport cannot hold the flight forever. The
            // race cannot cancel the redeem: a late success still saves and
            // surfaces through the orphan, never as a silent background add.
            const entry = await withLoadTimeout(
              startup.pair(inner, name, innerSignal),
              PRODUCTION_LOAD_TIMEOUT_MS,
            );
            // The first pairing turns the lock on, unless the person already chose.
            lock.enable();
            try {
              await lock.persisted();
            } catch (persistError) {
              // Durable save failed: toast for attention and inline `error`
              // below so the failure stays on screen after pairing closes.
              const message =
                persistError instanceof Error
                  ? persistError.message
                  : "The app-lock choice could not be saved. It applies until restart, then reverts.";
              setError(message);
              notify(message);
            }
            onChanged(startup.manager.entries());
            onSelect(entry.hostId);
            onPairingClose();
            return entry;
          } catch (pairError) {
            const typed =
              pairError instanceof PairingFlowError
                ? pairError
                : pairError instanceof Error && pairError.name === "LoadTimeoutError"
                  ? new PairingFlowError(
                      "daemon",
                      "Pairing timed out. Check the computer's devices: a late reply may still have saved, so create a new link before retrying.",
                    )
                  : null;
            const message =
              typed?.message ??
              (pairError instanceof Error ? pairError.message : "Pairing failed. Try again.");
            setError(message);
            throw typed ?? (pairError instanceof Error ? pairError : new Error(message));
          } finally {
            setBusy(false);
          }
        },
        {
          // Redeem trims the name, so the key trims too: `" My phone "` and
          // `"My phone"` are the same request and share. Case is preserved:
          // names are display strings, not identifiers.
          key: (inner: ConfirmedPairing, name: string) =>
            `${inner.link.daemonOrigin}|${inner.link.code}|${inner.link.fingerprint}|${name.trim()}`,
          busyError: () =>
            new PairingFlowError("daemon", "Pairing already in progress. Wait for it to finish."),
        },
      );
    }
    return pairFlightRef.current(confirmed, deviceName, signal);
  }

  async function remove(hostId: string) {
    setBusy(true);
    setError(null);
    try {
      await startup.remove(hostId);
      onChanged(startup.manager.entries());
    } catch (removeError) {
      const message =
        removeError instanceof Error ? removeError.message : "Remove failed. Try again.";
      setError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  }

  /** Prove the reviewed mutation gate before any mutating screen admits. */
  function access(hostId: string): string {
    try {
      startup.runtimeForMutation(hostId).check();
      return "Ready to act";
    } catch (gateError) {
      if (gateError instanceof ViewOnlyError) return "View only. Pair with View and act to change.";
      return "This machine is not connected.";
    }
  }

  if (entries.length === 0 || pairingOpen) {
    return (
      <View style={{ flex: 1 }}>
        {secureGuardFailed ? (
          <AceText role="caption">
            Screen protection could not be confirmed. Content stays guarded until it applies.
          </AceText>
        ) : null}
        {lockStorageFailed ? (
          <AceText role="caption">
            App-lock settings could not be loaded. Changes apply until restart, then revert.
          </AceText>
        ) : null}
        {entries.length > 0 ? (
          // Disabled while a pairing is in flight: abandoning redeem orphans
          // the burned single-use code (like iOS `.interactiveDismissDisabled`).
          <AceButton
            label="Back to machines"
            onPress={onPairingClose}
            kind="secondary"
            enabled={!busy}
          />
        ) : null}
        {error ? <AceText role="caption">{error}</AceText> : null}
        <PairingScreen
          pair={async (confirmed, deviceName, signal) => {
            await pair(confirmed, deviceName, signal);
          }}
          onPaired={() => {}}
        />
        {busy ? <AceText role="caption">Working…</AceText> : null}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: tokens.spacing.xl, gap: tokens.spacing.lg }}>
      <AceText role="title">Machines</AceText>
      {secureGuardFailed ? (
        <AceText role="caption">
          Screen protection could not be confirmed. Content stays guarded until it applies.
        </AceText>
      ) : null}
      {lockStorageFailed ? (
        <AceText role="caption">
          App-lock settings could not be loaded. Changes apply until restart, then revert.
        </AceText>
      ) : null}
      {cards.map((card) => {
        const message = routeMessage(card.route);
        return (
          <Group key={card.hostId}>
            <AceText role="rowTitle">{card.displayName}</AceText>
            <AceText role="caption">
              {card.canOperate ? "View and act" : "View only"}
              {activeHost === card.hostId ? " · Active" : ""}
            </AceText>
            {message ? <AceText role="caption">{message}</AceText> : null}
            <AceText role="caption">{access(card.hostId)}</AceText>
            {activeHost !== card.hostId ? (
              <AceButton
                label="Select"
                onPress={() => onSelect(card.hostId)}
                enabled={!busy}
                kind="secondary"
              />
            ) : null}
            <AceButton
              label="Remove"
              onPress={() => void remove(card.hostId)}
              enabled={!busy}
              kind="secondary"
            />
          </Group>
        );
      })}
      {error ? <AceText role="caption">{error}</AceText> : null}
      <AceButton label="Pair another machine" onPress={onPairingOpen} kind="secondary" />
      <LockSettings lock={lock} notify={notify} />
      <AceText role="caption">
        Threads for the active machine arrive with the inbox merge. Mutations stay behind the
        per-machine gate and fail closed while view-only or offline.
      </AceText>
    </View>
  );
}

/**
 * Persisted app-lock choice, mirroring the iOS Settings › Face ID screen
 * without copying it. Reads and writes through the same `createAppLock`
 * policy the startup gate enforces: there is no second lock
 * implementation. Turning the lock off asks for device authentication
 * first; the timeout writes through to the `ace-lock` namespace.
 */
function LockSettings({ lock, notify }: { lock: AppLock; notify(text: string): void }) {
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const refresh = () => setTick((v) => v + 1);
  async function setOn(on: boolean) {
    if (busy || lock.authenticating) return;
    setBusy(true);
    try {
      await lock.setEnabled(on);
      // The mirror already updated; a failed disk write must not silently
      // claim success — the choice applies until restart, then reverts.
      try {
        await lock.persisted();
        setSaveError(null);
      } catch (persistError) {
        const message =
          persistError instanceof Error
            ? persistError.message
            : "The app-lock choice could not be saved. It applies until restart, then reverts.";
        setSaveError(message);
        notify(message);
      }
    } finally {
      setBusy(false);
      refresh();
    }
  }
  async function setLockTimeout(seconds: number) {
    lock.setTimeout(seconds);
    try {
      await lock.persisted();
      setSaveError(null);
    } catch (persistError) {
      const message =
        persistError instanceof Error
          ? persistError.message
          : "The app-lock choice could not be saved. It applies until restart, then reverts.";
      setSaveError(message);
      notify(message);
    }
    refresh();
  }
  return (
    <Group>
      <AceText role="rowTitle">App lock</AceText>
      {saveError ? <AceText role="caption">{saveError}</AceText> : null}
      <AceText role="caption">
        {lock.enabled
          ? "On: unlock with this phone\u2019s screen lock."
          : "Off: machines open without asking."}
      </AceText>
      <AceButton
        label={lock.enabled ? "Turn off app lock" : "Turn on app lock"}
        onPress={() => void setOn(!lock.enabled)}
        enabled={!busy && !lock.authenticating}
        kind="secondary"
      />
      <AceText role="caption">
        Lock after{" "}
        {formatAppLockTimeout(lock.timeout)
          .replace(/^After /, "")
          .toLowerCase()}
      </AceText>
      <Column>
        {APP_LOCK_TIMEOUTS.map((seconds) => (
          <AceButton
            key={seconds}
            label={formatAppLockTimeout(seconds)}
            onPress={() => void setLockTimeout(seconds)}
            enabled={lock.enabled && !busy && lock.timeout !== seconds}
            kind={lock.timeout === seconds ? "primary" : "secondary"}
          />
        ))}
      </Column>
      <AceText role="caption">
        {"If this phone has a screen lock, turning the lock off asks for it first."}
      </AceText>
    </Group>
  );
}
