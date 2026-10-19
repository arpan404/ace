import { useEffect, useMemo, memo } from "react";
import { View, Text, Pressable } from "react-native";
import { FlashList } from "@shopify/flash-list";
import type { ClientApi, SidebarSource } from "@ace/client";
import { useSelection } from "./selection.ts";
import { AceHost, tokens, useTheme, textStyle } from "./theme.tsx";
import {
  AceText,
  Column,
  Row,
  StatusPill,
  padding,
  fillMaxWidth,
  background,
} from "./components.tsx";
import { clickable } from "@expo/ui/jetpack-compose/modifiers";
import { inboxSections, inboxStatus, type InboxThread } from "@ace/ui-core/mobile";
import { displayAppearance } from "./status.ts";

type InboxEntry = { kind: "heading"; id: string; title: string } | { kind: "thread"; id: string };
/** One daemon for now; rows keep a machine so a merged inbox can tell them apart later. */
const machineId = "local";
function inboxThread(store: SidebarSource, id: string): InboxThread | undefined {
  const entry = store.thread(id);
  return entry && { key: id, machineId, entry, unconfirmed: store.unconfirmed };
}
function entries(store: SidebarSource, now: number): InboxEntry[] {
  const threads: InboxThread[] = [];
  for (const id of store.ids) {
    const thread = inboxThread(store, id);
    if (thread) threads.push(thread);
  }
  const rows: InboxEntry[] = [];
  for (const section of inboxSections(threads, [], now)) {
    rows.push({ kind: "heading", id: `heading:${section.key}`, title: section.label });
    for (const id of section.keys) rows.push({ kind: "thread", id });
  }
  return rows;
}
const InboxRow = memo(function InboxRow({
  id,
  store,
  open,
  now,
}: {
  id: string;
  store: SidebarSource;
  open(id: string): void;
  now(): number;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () =>
      store.select(
        [`thread:${id}`, "unconfirmed", "sync"],
        () => inboxThread(store, id),
        (a, b) => a?.entry === b?.entry && a?.unconfirmed === b?.unconfirmed,
      ),
    [store, id],
  );
  const row = useSelection(selection);
  if (!row) return null;
  const thread = row.entry;
  const status = displayAppearance(inboxStatus(row, now()), theme);
  return (
    <View
      style={{
        borderBottomWidth: tokens.dimensions.border,
        borderBottomColor: theme.colours.separator,
      }}
    >
      <AceHost style={{ width: "100%" }}>
        <Column
          modifiers={[
            fillMaxWidth(),
            background(
              thread.status.state === "needs_you"
                ? theme.colours.needsYouSurface
                : theme.colours.background,
            ),
            clickable(() => open(id)),
            padding(tokens.spacing.xl, tokens.spacing.md, tokens.spacing.xl, tokens.spacing.md),
          ]}
          verticalArrangement={{ spacedBy: tokens.spacing.xs }}
        >
          <Row modifiers={[fillMaxWidth()]} horizontalArrangement="spaceBetween">
            <AceText role="caption" colour={theme.colours.mutedForeground}>
              {thread.workspaceId}
            </AceText>
            <StatusPill {...status} />
          </Row>
          <AceText role="rowTitle" maxLines={1}>
            {thread.title}
          </AceText>
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            {thread.provider} ·{" "}
            {thread.status.state === "working"
              ? `${thread.status.agents} ${thread.status.agents === 1 ? "agent" : "agents"}`
              : status.label}
          </AceText>
        </Column>
      </AceHost>
    </View>
  );
});
export function Inbox({
  client,
  open,
  machines,
  now,
}: {
  client: ClientApi;
  open(id: string): void;
  machines(): void;
  now(): number;
}) {
  const theme = useTheme();
  const lease = useMemo(() => client.threads(), [client]);
  useEffect(() => () => lease.release(), [lease]);
  const selection = useMemo(
    () =>
      lease.store.select(
        ["threads", "ids", "unconfirmed", "sync"],
        () => entries(lease.store, now()),
        (a, b) => a.length === b.length && a.every((v, i) => v.id === b[i]?.id),
      ),
    [lease, now],
  );
  const data = useSelection(selection);
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: tokens.spacing.xl,
          paddingVertical: tokens.spacing.sm,
          gap: tokens.spacing.md,
        }}
      >
        <Text style={{ ...textStyle("wordmark"), color: theme.colours.foreground }}>
          ace<Text style={{ color: theme.colours.accent }}>.</Text>
        </Text>
        <Pressable
          onPress={machines}
          accessibilityRole="button"
          accessibilityLabel="Machines"
          style={{ minHeight: tokens.dimensions.touchTarget, justifyContent: "center" }}
        >
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            Machines ›
          </Text>
        </Pressable>
      </View>
      <FlashList
        data={data}
        keyExtractor={(item) => item.id}
        getItemType={(item) => item.kind}
        renderItem={({ item }) =>
          item.kind === "thread" ? (
            <InboxRow id={item.id} store={lease.store} open={open} now={now} />
          ) : (
            <View
              style={{
                paddingHorizontal: tokens.spacing.xl,
                paddingTop: tokens.spacing.lg,
                paddingBottom: tokens.spacing.xs,
              }}
            >
              <Text style={{ ...textStyle("label"), color: theme.colours.mutedForeground }}>
                {item.title}
              </Text>
            </View>
          )
        }
        ListEmptyComponent={
          <Text
            style={{
              ...textStyle("body"),
              color: theme.colours.mutedForeground,
              padding: tokens.spacing.xl,
            }}
          >
            Connecting to your machine…
          </Text>
        }
      />
    </View>
  );
}
