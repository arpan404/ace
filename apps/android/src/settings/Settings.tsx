import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { tokens, useTheme, textStyle } from "../theme.tsx";
import { APPEARANCE_MODES, appearanceLabel, type AppearanceMode } from "./appearance.ts";
import {
  APP_LOCK_TIMEOUTS,
  requiresAuthToDisable,
  resolveDisableAfterAuth,
  type AuthOutcome,
} from "./appLock.ts";
import { collectDiagnosticsReport, renderDiagnosticsJson } from "./diagnostics.ts";
import appJson from "../../app.json";
import {
  DEFAULT_SETTINGS,
  createSerialQueue,
  createSettingsWriter,
  loadSettings,
  lockTimeoutLabel,
  nonLockPatch,
  resolveSettingsAfterSave,
  type SettingsKeyValue,
  type SettingsState,
} from "./store.ts";

export { DEFAULT_SETTINGS, loadSettings };

const APP_VERSION: string = appJson.expo.version ?? "0.0.1";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: tokens.spacing.xs }}>
      <Text style={{ ...textStyle("label"), color: theme.colours.mutedForeground }}>{title}</Text>
      <View
        style={{
          backgroundColor: theme.colours.secondaryBackground,
          borderRadius: tokens.radii.group,
          paddingHorizontal: tokens.spacing.md,
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Row({
  label,
  value,
  onPress,
  selected,
  testID,
  last,
}: {
  label: string;
  value?: string;
  onPress?: (() => void) | undefined;
  selected?: boolean;
  testID: string;
  last?: boolean;
}) {
  const theme = useTheme();
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: tokens.spacing.md,
        borderBottomWidth: last ? 0 : tokens.dimensions.border,
        borderBottomColor: theme.colours.separator,
        opacity: onPress === undefined ? 1 : 0.96,
      }}
    >
      <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
        {selected === true ? "✓ " : ""}
        {label}
      </Text>
      {value === undefined ? null : (
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {value}
        </Text>
      )}
    </View>
  );
  return onPress === undefined ? (
    <View testID={testID}>{body}</View>
  ) : (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
    >
      {body}
    </Pressable>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
  testID,
  last,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange(next: boolean): void;
  testID: string;
  last?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: tokens.spacing.sm,
        borderBottomWidth: last ? 0 : tokens.dimensions.border,
        borderBottomColor: theme.colours.separator,
      }}
    >
      <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
      />
    </View>
  );
}

/**
 * Phone-local settings matching the practical iOS Settings slice: Interface
 * (appearance, Send with Return), app lock preference and timeout, and a
 * redacted diagnostics export. Machines, notifications, archive, profiles,
 * and provider sign-in stay on the daemon-backed roadmap and are not shown.
 *
 * The lock toggle is enforced by the host app: turning it on takes effect on
 * the next backgrounding, turning it off asks for the device credentials
 * first, and the app shows a lock overlay while locked. Without an
 * `authenticate` host the lock section stays inert rather than pretending.
 */
export function SettingsScreen({
  initial,
  storage,
  onChange,
  notify,
  dismiss,
  authenticate,
}: {
  initial: SettingsState;
  storage: SettingsKeyValue;
  onChange?(next: SettingsState): void;
  notify?(text: string): void;
  dismiss(): void;
  authenticate?(reason: string): Promise<AuthOutcome>;
}) {
  const theme = useTheme();
  const [state, setState] = useState<SettingsState>(initial);
  const stateRef = useRef<SettingsState>(state);
  const storageRef = useRef<SettingsKeyValue>(storage);
  const writerRef = useRef(createSettingsWriter(storage));
  const authenticatingRef = useRef(false);
  const dirtyRef = useRef(false);
  // Commit queue: overlapping updates linearize end to end (see `update`),
  // so a failed save can only roll back its own patch.
  const commitQueueRef = useRef(createSerialQueue());

  // The phone database loads after first render: adopt the real storage and
  // its state. Interface edits made on the fallback migrate; the lock choice
  // and timeout never do, so an unauthenticated fallback edit cannot overwrite
  // the locked state (fail-closed migration).
  useEffect(() => {
    if (storageRef.current === storage) return;
    storageRef.current = storage;
    writerRef.current = createSettingsWriter(storage);
    if (dirtyRef.current) {
      const migrated = nonLockPatch(stateRef.current);
      if (Object.keys(migrated).length > 0) {
        void writerRef.current
          .save(migrated)
          .catch(() => notify?.("Settings could not be saved on this phone."));
      }
    } else {
      stateRef.current = initial;
      setState(initial);
    }
  }, [initial, storage, notify]);

  // Durable-save rule: the toggle follows storage, not intent. The whole
  // read-modify-write runs inside the commit queue, so overlapping updates
  // linearize: each patch is computed from the previous task's state, a
  // failed save rolls back only its own patch, and `onChange` fires only for
  // what was actually written. A failed lock-enable can never claim success
  // and restart unlocked, and a failed first save cannot roll back a newer
  // durable commit.
  function update(patch: Partial<SettingsState>): Promise<void> {
    return commitQueueRef.current.enqueue(() => applyUpdate(patch));
  }

  async function applyUpdate(patch: Partial<SettingsState>): Promise<void> {
    const previous = stateRef.current;
    const next: SettingsState = { ...previous, ...patch };
    stateRef.current = next;
    dirtyRef.current = true;
    setState(next);
    try {
      await writerRef.current.save(patch);
    } catch {
      notify?.("Settings could not be saved on this phone.");
      const committed = resolveSettingsAfterSave({ previous, next, saveSucceeded: false });
      stateRef.current = committed;
      setState(committed);
      return;
    }
    onChange?.(next);
  }

  // Turning the lock off asks the device owner first, mirroring iOS
  // `AppLock.setEnabled(false)`; a failed check keeps the lock as-is.
  async function setLockEnabled(next: boolean) {
    if (authenticatingRef.current) return;
    if (next === stateRef.current.lockEnabled) return;
    if (requiresAuthToDisable(stateRef.current.lockEnabled, next)) {
      if (authenticate === undefined) {
        notify?.("Device authentication is unavailable, so the app lock stays on.");
        return;
      }
      authenticatingRef.current = true;
      let outcome: AuthOutcome;
      try {
        outcome = await authenticate("Turn off the app lock");
      } catch {
        authenticatingRef.current = false;
        notify?.("Authentication failed. The app lock stays on.");
        return;
      }
      authenticatingRef.current = false;
      if (resolveDisableAfterAuth(stateRef.current.lockEnabled, outcome)) {
        if (outcome === "failed") notify?.("Authentication failed. The app lock stays on.");
        return;
      }
    }
    await update({ lockEnabled: next });
  }

  const [generatedAt] = useState(() => new Date().toISOString());
  const report = collectDiagnosticsReport({
    generatedAt,
    app: { version: APP_VERSION, build: APP_VERSION, system: "Android", device: "android" },
    machines: [],
    lock: { enabled: state.lockEnabled, timeoutSeconds: state.lockTimeoutSeconds },
  });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colours.background }}
      contentContainerStyle={{ padding: tokens.spacing.xl, gap: tokens.spacing.lg }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ ...textStyle("title"), color: theme.colours.foreground }}>Settings</Text>
        <Pressable
          testID="settings.close"
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={dismiss}
          style={{ minHeight: tokens.dimensions.touchTarget, justifyContent: "center" }}
        >
          <Text style={{ ...textStyle("body"), color: theme.colours.accent }}>Close</Text>
        </Pressable>
      </View>

      <Section title="Interface">
        {APPEARANCE_MODES.map((mode, index) => (
          <Row
            key={mode.id}
            label={mode.label}
            value={appearanceLabel(state.appearance)}
            selected={state.appearance === mode.id}
            last={index === APPEARANCE_MODES.length - 1}
            testID={`appearance.${mode.id}`}
            onPress={() => void update({ appearance: mode.id as AppearanceMode })}
          />
        ))}
        <ToggleRow
          label="Send with Return"
          value={state.returnSends}
          onChange={(next) => void update({ returnSends: next })}
          testID="settings.returnSends"
          last
        />
      </Section>

      <Section title="App lock">
        <ToggleRow
          label="Lock with biometrics or passcode"
          value={state.lockEnabled}
          onChange={(next) => void setLockEnabled(next)}
          testID="settings.lock.enabled"
          disabled={authenticate === undefined}
        />
        {APP_LOCK_TIMEOUTS.map((seconds, index) => (
          <Row
            key={seconds}
            label={lockTimeoutLabel(seconds)}
            selected={state.lockTimeoutSeconds === seconds}
            last={index === APP_LOCK_TIMEOUTS.length - 1}
            testID={`settings.lockTimeout.${seconds}`}
            onPress={
              authenticate === undefined
                ? undefined
                : () => void update({ lockTimeoutSeconds: seconds })
            }
          />
        ))}
        <Text
          style={{
            ...textStyle("caption"),
            color: theme.colours.mutedForeground,
            paddingVertical: tokens.spacing.sm,
          }}
        >
          Stored on this phone only. ace locks when you leave it for longer than the timeout, and
          turning the lock off asks for your biometrics or passcode.
        </Text>
      </Section>

      <Section title="App">
        <Row label="About" value={`ace ${APP_VERSION}`} testID="settings.about" last={false} />
        <View testID="settings.diagnostics" style={{ paddingVertical: tokens.spacing.sm }}>
          <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
            Send diagnostics
          </Text>
          <Text
            style={{
              ...textStyle("code"),
              color: theme.colours.mutedForeground,
              paddingTop: tokens.spacing.xs,
            }}
          >
            {renderDiagnosticsJson(report)}
          </Text>
        </View>
      </Section>
    </ScrollView>
  );
}
