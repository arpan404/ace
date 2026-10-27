import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { View, Text, Button, useColorScheme } from "react-native";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
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
import { isFixtureMode } from "./execution-mode.ts";
import { readExecutionMode } from "./native-mode.ts";
import { ThemeContext, tokens, useTheme, textStyle, AceHost } from "./theme.tsx";
import { Inbox } from "./Inbox.tsx";
import { ThreadScreen } from "./Thread.tsx";
import { ConversationSearchView } from "./ConversationSearch.tsx";
import { FileScreen, FilesScreen } from "./Files.tsx";
import { MachinesSheet } from "./sheets.tsx";
import Inter from "../assets/fonts/Inter.ttf";
import Mono from "../assets/fonts/JetBrainsMono.ttf";

type RootStack = {
  Inbox: undefined;
  Thread: { id: string; title: string; focusItemId?: string };
  Files: { id: string; title: string };
  File: { id: string; title: string; path: string; line?: number };
  Search: { threadId?: string } | undefined;
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
                  now={Date.now}
                  machines={() => setMachines(true)}
                  notify={notify}
                  // The fixture loopback is an explicit full-access device; real
                  // pairing leaves this absent (fail closed) until scopes say otherwise.
                  canAct
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
    void Promise.resolve()
      .then(() => readExecutionMode())
      .then((mode) => {
        if (!active) return undefined;
        if (!isFixtureMode(mode)) {
          setFailure("This build is not paired with a daemon yet.");
          return undefined;
        }
        return fixtureRuntime(mode);
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
  }, []);
  const c = tokens.schemes[scheme].colours;
  return (
    <ThemeContext.Provider value={scheme}>
      <SafeAreaProvider>
        <KeyboardProvider>
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
        </KeyboardProvider>
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}
