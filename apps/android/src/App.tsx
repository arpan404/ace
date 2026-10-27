import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { View, Text, Button, useColorScheme, AppState } from "react-native";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import * as LocalAuthentication from "expo-local-authentication";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import {
  NavigationContainer,
  DefaultTheme,
  useNavigation,
  useRoute,
} from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SnackbarHost, Snackbar, type SnackbarHostRef } from "@expo/ui/jetpack-compose";
import { fixtureRuntime, type Runtime } from "./runtime.ts";
import { isFixtureMode, type ExecutionMode } from "./execution-mode.ts";
import { readExecutionMode } from "./native-mode.ts";
import { ThemeContext, tokens, useTheme, textStyle, AceHost } from "./theme.tsx";
import { Inbox } from "./Inbox.tsx";
import { ArchiveScreen } from "./Archive.tsx";
import { ThreadScreen } from "./Thread.tsx";
import { ConversationSearchView } from "./ConversationSearch.tsx";
import { FileScreen, FilesScreen } from "./Files.tsx";
import { MachinesSheet } from "./sheets.tsx";
import { resolveAppearanceScheme } from "./settings/appearance.ts";
import { loadSettings, type SettingsKeyValue, type SettingsState } from "./settings/store.ts";
import { ensureSettingsTables, sqliteSettingsKeyValue } from "./settings/sqlite.ts";
import { SettingsScreen } from "./settings/Settings.tsx";
import { LockScreen, PrivacyCover } from "./settings/LockScreen.tsx";
import { toAuthOutcome } from "./settings/deviceAuth.ts";
import {
  isStaleUnlockAttempt,
  resolveInitialLocked,
  resolveUnlockAfterAuth,
  shouldRelockOnActive,
  shouldShowLockCover,
  shouldShowPrivacyCover,
  shouldStartRuntime,
  type AuthOutcome,
} from "./settings/appLock.ts";
import {
  resolveSecureScreenEnabled,
  setSecureScreenEnabledAsync,
} from "./settings/secureScreen.ts";
import { openDatabaseAsync } from "expo-sqlite";
import Inter from "../assets/fonts/Inter.ttf";
import Mono from "../assets/fonts/JetBrainsMono.ttf";

type RootStack = {
  Inbox: undefined;
  Thread: { id: string; title: string; focusItemId?: string };
  Files: { id: string; title: string };
  File: { id: string; title: string; path: string; line?: number };
  Search: { threadId?: string } | undefined;
  Settings: undefined;
  Archived: undefined;
};
const Stack = createNativeStackNavigator<RootStack>();
function ThreadSearchAction() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStack, "Thread">>();
  const route = useRoute<RouteProp<RootStack, "Thread">>();
  return (
    <Button
      title="Search"
      onPress={() => navigation.push("Search", { threadId: route.params.id })}
    />
  );
}
function Ready({
  runtime,
  failure,
  phoneSettings,
  onSettingsChange,
  onLockChange,
  canAct,
}: {
  runtime: Runtime | null;
  failure: string | undefined;
  phoneSettings: { storage: SettingsKeyValue; state: SettingsState };
  onSettingsChange(next: SettingsState): void;
  onLockChange(locked: boolean, lockEnabled: boolean): void;
  /**
   * Genuine pairing grant. The fixture loopback is full-access by construction;
   * production stays absent (fail closed) until pairing scopes wire through.
   */
  canAct?: boolean | undefined;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [machines, setMachines] = useState(false);
  const snackbar = useRef<SnackbarHostRef>(null);
  const notify = useCallback((message: string) => {
    void snackbar.current?.showSnackbar({ message, duration: "short" });
  }, []);
  // Phone-local app lock, mirroring iOS `AppLock`: locked on launch when the
  // lock is on, relocked after the chosen background timeout, and lifted only
  // through the device credentials. `unavailable` (no device credential
  // enrolled) unlocks, exactly like iOS: nothing to unlock with.
  const lockEnabled = phoneSettings.state.lockEnabled;
  const [locked, setLocked] = useState(() => resolveInitialLocked(phoneSettings.state, false));
  const [unlocking, setUnlocking] = useState(false);
  // Visible failure on the lock screen itself, mirroring iOS `AppLock.failed`:
  // the cover occludes the snackbar host, so a snackbar alone would never be
  // seen while locked. Cleared on success and on each fresh lock episode.
  const [failedAttempt, setFailedAttempt] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const lockCover = shouldShowLockCover({ locked, lockEnabled });
  const privacyCover = shouldShowPrivacyCover({ locked, lockEnabled, appState });
  useEffect(() => {
    onLockChange(locked, lockEnabled);
  }, [locked, lockEnabled, onLockChange]);
  // Lock-episode generation: each fresh lock bumps it, and only the latest
  // episode's device check may open the lock, so a stale prompt answered
  // after a relock can never unlock the new episode. Reentry always needs
  // its own fresh authentication.
  const lockGenerationRef = useRef(0);
  const unlockingRef = useRef(false);
  const backgroundedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      setAppState(status);
      if (status === "background") {
        if (backgroundedAtRef.current === null) backgroundedAtRef.current = Date.now();
      } else if (status === "active") {
        const backgroundedAtMs = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (
          shouldRelockOnActive({
            enabled: lockEnabled,
            locked,
            backgroundedAtMs,
            nowMs: Date.now(),
            timeoutSeconds: phoneSettings.state.lockTimeoutSeconds,
          })
        ) {
          lockGenerationRef.current += 1;
          setLocked(true);
          setFailedAttempt(false);
        }
      }
    });
    return () => subscription.remove();
  }, [phoneSettings, lockEnabled, locked]);
  const authenticate = useCallback(async (reason: string): Promise<AuthOutcome> => {
    try {
      if (!(await LocalAuthentication.hasHardwareAsync())) return toAuthOutcome(false, false);
      if (!(await LocalAuthentication.isEnrolledAsync())) return toAuthOutcome(false, false);
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        fallbackLabel: "Use passcode",
      });
      return toAuthOutcome(result.success, true);
    } catch {
      return "failed";
    }
  }, []);
  const unlock = useCallback(async () => {
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    const generation = lockGenerationRef.current;
    setUnlocking(true);
    try {
      const outcome = await authenticate("Unlock your paired machines");
      if (
        isStaleUnlockAttempt({
          attemptGeneration: generation,
          currentGeneration: lockGenerationRef.current,
        })
      ) {
        return;
      }
      const resolved = resolveUnlockAfterAuth(outcome);
      if (resolved.unlocked) {
        setFailedAttempt(false);
        setLocked(false);
      } else {
        setFailedAttempt(true);
      }
    } finally {
      unlockingRef.current = false;
      setUnlocking(false);
    }
    // Stable identity keeps the lock-episode effect from refiring: the
    // dependency is itself stable (empty-dep callback over imports).
    // oxlint-disable-next-line react/memo-dependencies
  }, [authenticate]);
  // Mirror iOS `LockView.task { await lock.unlock() }`: each lock episode
  // prompts the device owner at once instead of waiting for a tap.
  const lockEpisodeRef = useRef(false);
  useEffect(() => {
    if (!lockCover) {
      lockEpisodeRef.current = false;
      return;
    }
    if (lockEpisodeRef.current) return;
    lockEpisodeRef.current = true;
    void unlock();
  }, [lockCover, unlock]);
  const navigationTheme = useMemo(
    () => ({
      ...DefaultTheme,
      colors: {
        ...DefaultTheme.colors,
        background: theme.colours.background,
        card: theme.colours.background,
        text: theme.colours.foreground,
        border: theme.colours.separator,
        primary: theme.colours.accent,
        notification: theme.status.needsYou,
      },
    }),
    [theme],
  );
  return (
    <View
      style={{ flex: 1, paddingBottom: insets.bottom, backgroundColor: theme.colours.background }}
    >
      {runtime ? (
        <NavigationContainer theme={navigationTheme}>
          <Stack.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: theme.colours.background },
              headerTintColor: theme.colours.foreground,
              headerTitleStyle: {
                fontFamily: tokens.typography.family,
                fontSize: tokens.typography.typeScale.title.size,
              },
              contentStyle: { backgroundColor: theme.colours.background },
              animation: "default",
            }}
          >
            <Stack.Screen name="Inbox" options={{ headerShown: false }}>
              {({ navigation }) => (
                <View style={{ flex: 1, paddingTop: insets.top }}>
                  <Inbox
                    client={runtime.client}
                    now={Date.now}
                    machines={() => setMachines(true)}
                    settings={() => navigation.push("Settings")}
                    notify={notify}
                    // Genuine grant only: fixture loopback is full-access, real
                    // pairing stays absent (fail closed) until scopes say otherwise.
                    canAct={canAct}
                    onSearch={() => navigation.push("Search", undefined)}
                    open={(id) =>
                      navigation.push("Thread", {
                        id,
                        title: id === "stream-thread" ? "ace CLI phase 2" : "Thread",
                      })
                    }
                  />
                </View>
              )}
            </Stack.Screen>
            <Stack.Screen name="Search" options={{ title: "Search" }}>
              {({ navigation, route }) => (
                <ConversationSearchView
                  client={runtime.client}
                  threadId={route.params?.threadId}
                  open={(id, title, itemId) =>
                    navigation.push("Thread", {
                      id,
                      title,
                      ...(itemId ? { focusItemId: itemId } : {}),
                    })
                  }
                />
              )}
            </Stack.Screen>
            <Stack.Screen
              name="Thread"
              options={({ route }) => ({
                title: route.params.title,
                headerRight: ThreadSearchAction,
              })}
            >
              {({ route, navigation }) => (
                <ThreadScreen
                  client={runtime.client}
                  id={route.params.id}
                  focusItemId={route.params.focusItemId}
                  hostId={runtime.hostId}
                  drafts={runtime.drafts}
                  notify={notify}
                  onOpenFiles={() =>
                    navigation.push("Files", { id: route.params.id, title: route.params.title })
                  }
                  returnSends={phoneSettings.state.returnSends}
                  canAct={canAct}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Files" options={{ title: "Files" }}>
              {({ route, navigation }) => (
                <FilesScreen
                  client={runtime.client}
                  scope={{ threadId: route.params.id }}
                  notify={notify}
                  onOpenFile={(path, line) =>
                    navigation.push("File", {
                      id: route.params.id,
                      title: route.params.title,
                      path,
                      ...(line === undefined ? {} : { line }),
                    })
                  }
                />
              )}
            </Stack.Screen>
            <Stack.Screen
              name="File"
              options={({ route }) => ({ title: route.params.path.split("/").pop() ?? "File" })}
            >
              {({ route }) => (
                <FileScreen
                  client={runtime.client}
                  scope={{ threadId: route.params.id }}
                  path={route.params.path}
                  {...(route.params.line === undefined ? {} : { line: route.params.line })}
                  notify={notify}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Settings" options={{ headerShown: false }}>
              {({ navigation }) => (
                <View style={{ flex: 1, paddingTop: insets.top }}>
                  <SettingsScreen
                    initial={phoneSettings.state}
                    storage={phoneSettings.storage}
                    onChange={onSettingsChange}
                    notify={notify}
                    dismiss={() => navigation.goBack()}
                    authenticate={authenticate}
                    onArchived={() => navigation.push("Archived")}
                  />
                </View>
              )}
            </Stack.Screen>
            <Stack.Screen name="Archived" options={{ title: "Archived" }}>
              {({ navigation }) => (
                <ArchiveScreen
                  client={runtime.client}
                  now={Date.now}
                  notify={notify}
                  // Same genuine grant as the inbox: fixture full-access, real
                  // pairing absent (fail closed) until scopes say otherwise.
                  canAct={canAct}
                  open={(id) => navigation.push("Thread", { id, title: "Thread" })}
                />
              )}
            </Stack.Screen>
          </Stack.Navigator>
        </NavigationContainer>
      ) : (
        <View
          testID="app.connecting"
          style={{
            flex: 1,
            justifyContent: "center",
            padding: tokens.spacing.xl,
            backgroundColor: theme.colours.background,
          }}
        >
          <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
            {failure ?? "Connecting…"}
          </Text>
        </View>
      )}
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          bottom: insets.bottom + tokens.spacing.md,
          left: tokens.spacing.md,
          right: tokens.spacing.md,
        }}
      >
        <AceHost>
          <SnackbarHost ref={snackbar}>
            <Snackbar
              containerColor={theme.colours.foreground}
              contentColor={theme.colours.background}
              actionContentColor={theme.colours.background}
            />
          </SnackbarHost>
        </AceHost>
      </View>
      {machines && runtime ? (
        <MachinesSheet client={runtime.client} dismiss={() => setMachines(false)} notify={notify} />
      ) : null}
      {lockCover ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          }}
        >
          <LockScreen
            unlock={() => void unlock()}
            authenticating={unlocking}
            failed={failedAttempt}
          />
        </View>
      ) : privacyCover ? (
        <PrivacyCover />
      ) : null}
    </View>
  );
}
export function App() {
  const systemScheme = useColorScheme() === "dark" ? "dark" : "light";
  const [phoneSettings, setPhoneSettings] = useState<{
    storage: SettingsKeyValue;
    state: SettingsState;
  } | null>(null);
  // Fail-closed storage: a phone database that will not open leaves the app
  // locked on a storage-unavailable screen, mirroring iOS `ProductionApp.make`
  // returning nil. Falling back to unlocked defaults would expose threads.
  const [settingsFailed, setSettingsFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const db = await openDatabaseAsync("ace-settings.db");
        await ensureSettingsTables(db);
        const storage = sqliteSettingsKeyValue(db);
        const state = await loadSettings(storage);
        if (active) setPhoneSettings({ storage, state });
      } catch {
        if (active) setSettingsFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  // Fail-closed runtime gate, mirroring iOS `RootView.task(id: lock.locked)`:
  // nothing connects until the lock releases. The gate starts locked and only
  // the live lock state opens it, so private content never loads behind the
  // cover. Once opened it stays open: relocking covers the UI without dropping
  // the connection, exactly like iOS keeping its loaded machines.
  const [gate, setGate] = useState({ locked: true, lockEnabled: true });
  const onLockChange = useCallback((locked: boolean, lockEnabled: boolean) => {
    setGate((current) =>
      current.locked === locked && current.lockEnabled === lockEnabled
        ? current
        : { locked, lockEnabled },
    );
  }, []);
  const runtimeAllowed = shouldStartRuntime({
    settingsLoaded: phoneSettings !== null,
    storageFailed: settingsFailed,
    locked: gate.locked,
    lockEnabled: gate.lockEnabled,
  });
  // OS-level recents guard: FLAG_SECURE blanks the window in the switcher and
  // blocks screenshots while the lock is on. Fail-closed like the runtime
  // gate (secure until the durable choice is known), best-effort when the
  // bridge is unavailable. The JS privacy cover stays as defense in depth.
  const secureScreenEnabled = resolveSecureScreenEnabled({
    lockEnabled: phoneSettings?.state.lockEnabled ?? gate.lockEnabled,
    settingsLoaded: phoneSettings !== null,
    storageFailed: settingsFailed,
  });
  // Honest async toggle: a promise-like native result settles later, so the
  // sync call must never claim success for it. Fail-closed default stays.
  useEffect(() => {
    void setSecureScreenEnabledAsync(secureScreenEnabled);
  }, [secureScreenEnabled]);
  const [connectArmed, setConnectArmed] = useState(false);
  // Latch during render (guarded, so it fires once): once the lock releases,
  // the runtime may start, and relocking must not disarm it.
  if (runtimeAllowed && !connectArmed) setConnectArmed(true);
  const scheme = resolveAppearanceScheme(phoneSettings?.state.appearance ?? "system", systemScheme);
  const [fonts, error] = useFonts({ Inter, "JetBrains Mono": Mono });
  const [runtime, setRuntime] = useState<Runtime>();
  const [failure, setFailure] = useState<string>();
  // Genuine grant source: the validated native build mode. Fixture builds run
  // the loopback, which is full-access by construction; production has no
  // transport here yet and stays view-only (absent) until pairing scopes wire
  // through. Unknown or unreadable mode fails closed.
  const [mode, setMode] = useState<ExecutionMode | null>(null);
  const canAct = mode !== null && isFixtureMode(mode) ? true : undefined;
  useEffect(() => {
    if (!connectArmed) return;
    let active = true;
    let owner: Runtime | undefined;
    void Promise.resolve()
      .then(() => readExecutionMode())
      .then((nextMode) => {
        if (!active) return undefined;
        setMode(nextMode);
        if (!isFixtureMode(nextMode)) {
          setFailure("This build is not paired with a daemon yet.");
          return undefined;
        }
        return fixtureRuntime(nextMode);
      })
      .then((value) => {
        if (value === undefined) return;
        owner = value;
        if (active) setRuntime(value);
        else void value.close();
      })
      .catch(() => {
        if (active) setFailure("The connection could not start.");
      });
    return () => {
      active = false;
      void owner?.close();
    };
  }, [connectArmed]);
  const c = tokens.schemes[scheme].colours;
  return (
    <ThemeContext.Provider value={scheme}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <StatusBar style={scheme === "dark" ? "light" : "dark"} />
          {!fonts ? (
            <View
              style={{
                flex: 1,
                justifyContent: "center",
                padding: tokens.spacing.xl,
                backgroundColor: c.background,
              }}
            >
              <Text style={{ ...textStyle("body"), color: c.foreground }}>
                {failure ?? (error ? "The bundled font could not load." : "Opening ace…")}
              </Text>
            </View>
          ) : settingsFailed ? (
            <View
              testID="settings.storageUnavailable"
              style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
                padding: tokens.spacing.xl,
                gap: tokens.spacing.md,
                backgroundColor: c.background,
              }}
            >
              <Text style={{ ...textStyle("title"), color: c.foreground }}>
                Storage unavailable
              </Text>
              <Text style={{ ...textStyle("body"), color: c.foreground }}>
                ace couldn&apos;t open its storage on this phone.
              </Text>
            </View>
          ) : !phoneSettings ? (
            <View
              testID="app.startupCover"
              style={{
                flex: 1,
                justifyContent: "center",
                padding: tokens.spacing.xl,
                backgroundColor: c.background,
              }}
            >
              <Text style={{ ...textStyle("body"), color: c.foreground }}>Opening ace…</Text>
            </View>
          ) : (
            <Ready
              runtime={runtime ?? null}
              failure={failure}
              phoneSettings={phoneSettings}
              onSettingsChange={(state) =>
                setPhoneSettings((current) =>
                  current ? { storage: current.storage, state } : current,
                )
              }
              onLockChange={onLockChange}
              canAct={canAct}
            />
          )}
        </KeyboardProvider>
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}
