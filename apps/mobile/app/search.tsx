import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Bot,
  ChevronLeft,
  FolderGit2,
  Plus,
  Search,
  Server,
  SlidersHorizontal,
} from "lucide-react-native";
import { useTheme } from "../src/design/ThemeContext";
import { Layout, withAlpha } from "../src/design/system";
import {
  EmptyState,
  IconButton,
  Panel,
  ScreenBackdrop,
  ScreenHeaderV2,
  SearchField,
  SectionTitle,
  StatusBadge,
} from "../src/design/primitives";
import { useHostStore } from "../src/store/HostStore";
import { useAggregatedOrchestration } from "../src/orchestration/mobileData";
import {
  buildMobileQuickSearchItems,
  type MobileQuickSearchItem,
} from "../src/search/mobileQuickSearch";

function itemIcon(item: MobileQuickSearchItem) {
  if (item.kind === "action") {
    return item.target === "settings" ? SlidersHorizontal : Plus;
  }
  if (item.kind === "host") return Server;
  if (item.kind === "project") return FolderGit2;
  return Bot;
}

function itemTone(item: MobileQuickSearchItem): "accent" | "success" | "muted" {
  if (item.kind === "action") {
    return "accent";
  }
  if (item.kind === "host") {
    return item.connected ? "success" : "muted";
  }
  if (item.kind === "project") {
    return "accent";
  }
  return "success";
}

export default function SearchScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const hosts = useHostStore((state) => state.hosts);
  const { connections, projects, threads } = useAggregatedOrchestration();
  const [query, setQuery] = useState("");

  const connectedHostIds = useMemo(
    () =>
      new Set(
        connections
          .filter((connection) => connection.status.kind === "connected")
          .map((connection) => connection.host.id),
      ),
    [connections],
  );

  const items = useMemo(
    () =>
      buildMobileQuickSearchItems({
        connectedHostIds,
        hosts,
        projects,
        query,
        threads,
      }),
    [connectedHostIds, hosts, projects, query, threads],
  );

  const openItem = (item: MobileQuickSearchItem) => {
    if (item.kind === "action") {
      if (item.target === "pairing") {
        router.push("/pairing");
      } else if (item.target === "projects") {
        router.push("/projects");
      } else {
        router.push("/settings");
      }
      return;
    }
    if (item.kind === "host") {
      router.push({ pathname: "/host/[hostId]", params: { hostId: item.hostId } });
      return;
    }
    if (item.kind === "project") {
      router.push({ pathname: "/project/[projectId]", params: { projectId: item.projectId } });
      return;
    }
    router.push({
      pathname: "/thread/[threadId]",
      params: { threadId: item.threadId, hostId: item.hostId },
    });
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenBackdrop />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 32,
        }}
      >
        <ScreenHeaderV2
          eyebrow="Quick search"
          title="Search"
          subtitle="Jump to hosts, projects, threads, and common actions."
          actions={
            <View style={styles.headerActions}>
              <StatusBadge label={`${items.length} found`} tone="muted" />
              <IconButton icon={ChevronLeft} label="Back" onPress={() => router.back()} />
            </View>
          }
        />

        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Find hosts, projects, or threads"
          icon={Search}
        />

        <View style={styles.sectionHeader}>
          <SectionTitle>Results</SectionTitle>
          <Text style={[styles.sectionMeta, { color: colors.text.tertiary }]}>
            {query.trim() ? "Filtered" : "Suggested"}
          </Text>
        </View>

        {items.length === 0 ? (
          <EmptyState
            title="No matches"
            body="Search by host name, workspace path, project title, thread title, or recent thread text."
          />
        ) : (
          <Panel padded={false} style={styles.resultsPanel}>
            {items.map((item, index) => (
              <SearchResultRow
                key={item.id}
                item={item}
                isLast={index === items.length - 1}
                onPress={() => openItem(item)}
              />
            ))}
          </Panel>
        )}
      </ScrollView>
    </View>
  );
}

function SearchResultRow({
  item,
  isLast,
  onPress,
}: {
  item: MobileQuickSearchItem;
  isLast: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const Icon = itemIcon(item);
  const tone = itemTone(item);
  const toneColor =
    tone === "success" ? colors.green : tone === "accent" ? colors.primary : colors.muted;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) =>
        [
          styles.resultRow,
          {
            backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
          },
        ] as StyleProp<ViewStyle>
      }
    >
      <View style={[styles.resultIcon, { backgroundColor: withAlpha(toneColor, 0.14) }]}>
        <Icon size={17} color={toneColor} strokeWidth={2.2} />
      </View>
      <View style={styles.resultCopy}>
        <View style={styles.resultHeader}>
          <Text style={[styles.resultTitle, { color: colors.text.primary }]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={[styles.resultKind, { color: colors.text.tertiary }]}>
            {item.kind.toUpperCase()}
          </Text>
        </View>
        <Text style={[styles.resultSubtitle, { color: colors.text.secondary }]} numberOfLines={2}>
          {item.subtitle}
        </Text>
      </View>
      {!isLast ? (
        <View style={[styles.separator, { backgroundColor: colors.border.soft }]} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  sectionHeader: {
    marginTop: 24,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionMeta: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  resultsPanel: {
    overflow: "hidden",
  },
  resultRow: {
    minHeight: 82,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  resultIcon: {
    width: 40,
    height: 40,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  resultCopy: {
    flex: 1,
    minWidth: 0,
  },
  resultHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  resultTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "900",
  },
  resultKind: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "900",
  },
  resultSubtitle: {
    marginTop: 5,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 71,
    right: 18,
    height: StyleSheet.hairlineWidth,
  },
});
