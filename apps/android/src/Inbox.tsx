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
import { statusAppearance } from "./status.ts";

type InboxEntry = { kind: "heading"; id: string; title: string } | { kind: "thread"; id: string };
const order = ["Needs you", "Working", "Waiting", "Done"];
function entries(store: SidebarSource): InboxEntry[] {
  const groups = new Map<string, string[]>();
  for (const id of store.ids) {
    const thread = store.thread(id);
    if (!thread) continue;
    const group =
      thread.status.state === "needs_you"
        ? "Needs you"
        : thread.status.state === "working"
          ? "Working"
          : thread.status.state === "done"
            ? "Done"
            : "Waiting";
    const list = groups.get(group) ?? [];
    list.push(id);
    groups.set(group, list);
  }
  const rows: InboxEntry[] = [];
  for (const title of order) {
    const ids = groups.get(title) ?? [];
    if (!ids.length) continue;
    rows.push({ kind: "heading", id: `heading:${title}`, title });
    for (const id of ids) rows.push({ kind: "thread", id });
  }
  return rows;
}
const InboxRow = memo(function InboxRow({
  id,
  store,
  open,
}: {
  id: string;
  store: SidebarSource;
  open(id: string): void;
}) {
  const theme = useTheme();
  const selection = useMemo(() => store.select([`thread:${id}`], (r) => r.thread(id)), [store, id]);
  const thread = useSelection(selection);
  if (!thread) return null;
  const status = statusAppearance(thread.status, theme);
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
}: {
  client: ClientApi;
  open(id: string): void;
  machines(): void;
}) {
  const theme = useTheme();
  const lease = useMemo(() => client.threads(), [client]);
  useEffect(() => () => lease.release(), [lease]);
  const selection = useMemo(
    () =>
      lease.store.select(
        ["threads", "ids"],
        () => entries(lease.store),
        (a, b) => a.length === b.length && a.every((v, i) => v.id === b[i]?.id),
      ),
    [lease],
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
            <InboxRow id={item.id} store={lease.store} open={open} />
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
