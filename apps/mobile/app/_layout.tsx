import "react-native-get-random-values";
import { Stack, useRouter } from "expo-router";
import { Platform, StatusBar } from "react-native";
import { useEffect, useRef, useState } from "react";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import type { OrchestrationEvent } from "@ace/contracts";
import { ThemeProvider, useTheme } from "../src/design/ThemeContext";
import { initializeConnections } from "../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../src/rpc/ConnectionManager";
import { notificationFromDomainEvent, notificationThreadRouteFromData } from "../src/notifications";
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono";
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
} from "@expo-google-fonts/ibm-plex-sans";

const MAX_NOTIFICATION_EVENT_CACHE = 300;

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
});

function trimEventCache(cache: Set<string>) {
  while (cache.size > MAX_NOTIFICATION_EVENT_CACHE) {
    const oldest = cache.values().next().value;
    if (!oldest) {
      return;
    }
    cache.delete(oldest);
  }
}

async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("agent-attention", {
      name: "Agent attention",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) {
    return true;
  }
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

function MobileNotificationBridge() {
  const router = useRouter();
  const [connections, setConnections] = useState<ReadonlyArray<ManagedConnection>>(() =>
    connectionManager.getConnections(),
  );
  const notificationsEnabledRef = useRef(false);
  const notifiedEventIdsRef = useRef(new Set<string>());

  useEffect(() => {
    let mounted = true;
    void ensureNotificationPermission()
      .then((enabled) => {
        if (mounted) {
          notificationsEnabledRef.current = enabled;
        }
      })
      .catch(() => {
        if (mounted) {
          notificationsEnabledRef.current = false;
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return connectionManager.onStatusChange((nextConnections) => {
      setConnections(nextConnections);
    });
  }, []);

  useEffect(() => {
    const notifyFromEvent = async (event: OrchestrationEvent, hostId: string) => {
      if (!notificationsEnabledRef.current) {
        return;
      }

      const notifiedEventIds = notifiedEventIdsRef.current;
      if (notifiedEventIds.has(event.eventId)) {
        return;
      }
      notifiedEventIds.add(event.eventId);
      trimEventCache(notifiedEventIds);

      const notification = notificationFromDomainEvent(event);
      if (!notification) {
        return;
      }

      await Notifications.scheduleNotificationAsync({
        content: {
          title: notification.title,
          body: notification.body,
          data: {
            hostId,
            threadId: String(event.aggregateId),
            eventType: event.type,
          },
        },
        trigger: null,
      });
    };

    const unsubscribeFns = connections
      .filter((connection) => connection.status.kind === "connected")
      .map((connection) =>
        connection.client.orchestration.onDomainEvent((event) => {
          void notifyFromEvent(event, connection.host.id).catch(() => {
            notificationsEnabledRef.current = false;
          });
        }),
      );

    return () => {
      unsubscribeFns.forEach((unsubscribe) => unsubscribe());
    };
  }, [connections]);

  useEffect(() => {
    const openThreadFromNotification = (response: Notifications.NotificationResponse) => {
      const route = notificationThreadRouteFromData(
        response.notification.request.content.data as Readonly<Record<string, unknown>>,
      );
      if (!route) {
        return;
      }
      router.push({
        pathname: "/thread/[threadId]",
        params: {
          threadId: route.threadId,
          hostId: route.hostId,
        },
      });
    };

    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse) {
      openThreadFromNotification(lastResponse);
      Notifications.clearLastNotificationResponse();
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      openThreadFromNotification(response);
      Notifications.clearLastNotificationResponse();
    });
    return () => {
      subscription.remove();
    };
  }, [router]);

  return null;
}

function RootNavigator() {
  const { isDark, colors } = useTheme();

  return (
    <>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      <MobileNotificationBridge />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: Platform.OS === "ios" ? "default" : "fade_from_bottom",
          animationDuration: 250,
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="pairing"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen
          name="profile"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen
          name="search"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen name="project/[projectId]" options={{ animation: "default" }} />
        <Stack.Screen name="host/[hostId]" options={{ animation: "default" }} />
        <Stack.Screen name="thread/[threadId]" options={{ animation: "default" }} />
        <Stack.Screen
          name="thread/terminal"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen name="thread/browser" options={{ animation: "default" }} />
        <Stack.Screen name="settings/device/[id]" options={{ animation: "default" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });

  useEffect(() => {
    void initializeConnections();
  }, []);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <RootNavigator />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
