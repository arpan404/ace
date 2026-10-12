import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { View, Text, useColorScheme } from "react-native";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SnackbarHost, Snackbar, type SnackbarHostRef } from "@expo/ui/jetpack-compose";
import { fixtureRuntime, type Runtime } from "./runtime.ts";
import { ThemeContext, tokens, useTheme, textStyle, AceHost } from "./theme.tsx";
import { Inbox } from "./Inbox.tsx";
import { ThreadScreen } from "./Thread.tsx";
import { MachinesSheet } from "./sheets.tsx";
import Inter from "../assets/fonts/Inter.ttf";
import Mono from "../assets/fonts/JetBrainsMono.ttf";

const Stack = createNativeStackNavigator<{
  Inbox: undefined;
  Thread: { id: string; title: string };
}>();
function Ready({ runtime }: { runtime: Runtime }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [machines, setMachines] = useState(false);
  const snackbar = useRef<SnackbarHostRef>(null);
  const notify = useCallback((message: string) => {
    void snackbar.current?.showSnackbar({ message, duration: "short" });
  }, []);
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
                  machines={() => setMachines(true)}
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
          <Stack.Screen name="Thread" options={({ route }) => ({ title: route.params.title })}>
            {({ route }) => (
              <ThreadScreen client={runtime.client} id={route.params.id} notify={notify} />
            )}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
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
      {machines ? (
        <MachinesSheet client={runtime.client} dismiss={() => setMachines(false)} notify={notify} />
      ) : null}
    </View>
  );
}
export function App() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const [fonts, error] = useFonts({ Inter, "JetBrains Mono": Mono });
  const [runtime, setRuntime] = useState<Runtime>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let active = true;
    let owner: Runtime | undefined;
    void fixtureRuntime()
      .then((value) => {
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
  }, []);
  const c = tokens.schemes[scheme].colours;
  return (
    <ThemeContext.Provider value={scheme}>
      <SafeAreaProvider>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        {runtime && fonts ? (
          <Ready runtime={runtime} />
        ) : (
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
        )}
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}
