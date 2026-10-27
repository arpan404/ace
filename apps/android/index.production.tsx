import { useCallback, useRef } from "react";
import { useColorScheme, View } from "react-native";
import { registerRootComponent } from "expo";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { SnackbarHost, Snackbar, type SnackbarHostRef } from "@expo/ui/jetpack-compose";
import { AceHost, ThemeContext, tokens, useTheme } from "./src/theme.tsx";
import { ProductionRoot } from "./src/production/ProductionRoot.tsx";

/**
 * Production entry: secure startup over the pinned native bridge, the
 * Keystore credential store and per-machine SQLite namespaces. Nothing here
 * imports the fixture runtime, the replay probe or input metrics, and the
 * React Native default fetch/WebSocket never carries pairing material: when
 * the pinned bridge is missing the root fails closed to an unpaired message.
 *
 * Failure feedback is the same Snackbar plumbing the fixture `Ready` shell
 * uses: `ProductionRoot` requires `notify`, so the entry owns a host and
 * passes a real callback. Durable lock-save and secure-screen failures also
 * render inline captions inside the root, so a missed toast never hides them.
 */
function ProductionApp() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  return (
    <ThemeContext.Provider value={scheme}>
      <SafeAreaProvider>
        <ProductionShell />
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}

function ProductionShell() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const snackbar = useRef<SnackbarHostRef>(null);
  const notify = useCallback((message: string) => {
    void snackbar.current?.showSnackbar({ message, duration: "short" });
  }, []);
  return (
    <View style={{ flex: 1, backgroundColor: theme.colours.background }}>
      <ProductionRoot notify={notify} />
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
    </View>
  );
}

registerRootComponent(ProductionApp);
