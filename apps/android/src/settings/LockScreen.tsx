import { Pressable, Text, View } from "react-native";
import { tokens, useTheme, textStyle } from "../theme.tsx";

/**
 * Full-screen gate shown while the app lock holds, mirroring iOS `LockView`
 * (`RootView` covers the inbox with "ace is locked" until `AppLock.unlock`
 * succeeds). Reaching this screen already proves the lock is on; unlocking
 * asks the device owner through the host's `authenticate`.
 */
export function LockScreen({
  unlock,
  authenticating,
  failed,
}: {
  unlock(): void;
  authenticating: boolean;
  failed: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      testID="appLock.screen"
      style={{
        flex: 1,
        backgroundColor: theme.colours.background,
        justifyContent: "center",
        alignItems: "center",
        padding: tokens.spacing.xl,
        gap: tokens.spacing.md,
      }}
    >
      <Text style={{ ...textStyle("title"), color: theme.colours.foreground }}>ace is locked</Text>
      <Text
        style={{
          ...textStyle("caption"),
          color: theme.colours.mutedForeground,
          textAlign: "center",
        }}
      >
        Unlock with your biometrics or passcode to continue.
      </Text>
      {failed ? (
        <Text
          testID="appLock.error"
          style={{
            ...textStyle("caption"),
            color: theme.colours.mutedForeground,
            textAlign: "center",
          }}
        >
          {"Couldn't verify it's you."}
        </Text>
      ) : null}
      <Pressable
        testID="appLock.unlock"
        accessibilityRole="button"
        accessibilityLabel="Unlock"
        onPress={unlock}
        disabled={authenticating}
        style={{
          minHeight: tokens.dimensions.touchTarget,
          justifyContent: "center",
          paddingHorizontal: tokens.spacing.xl,
        }}
      >
        <Text style={{ ...textStyle("body"), color: theme.colours.accent }}>
          {authenticating ? "Checking…" : "Unlock"}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Opaque background cover, mirroring iOS `PrivacyCover`: rendered over the
 * unlocked content whenever the app is not active and the lock is on.
 * Defense in depth only: the real switcher guarantee is `FLAG_SECURE` on the
 * window (see `secureScreen.ts`), which the OS enforces at composition time
 * regardless of when JS learns about the backgrounding.
 */
export function PrivacyCover() {
  const theme = useTheme();
  return (
    <View
      testID="privacy.cover"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: theme.colours.background,
      }}
    />
  );
}
