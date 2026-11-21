import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import type { ClientApi } from "@ace/client";
import { useSelection } from "./selection.ts";
import { AceHost, tokens, useTheme, textStyle } from "./theme.tsx";
import { AceButton } from "./components.tsx";
import {
  ConversationSearch,
  hitExcerpt,
  hitId,
  type ConversationHit,
  type ConversationSearchKind,
} from "./conversation-search.ts";

const KINDS: { label: string; value: ConversationSearchKind }[] = [
  { label: "Everything", value: "" },
  { label: "Titles", value: "thread" },
  { label: "Messages", value: "message" },
  { label: "Tools", value: "tool_call" },
  { label: "Files", value: "artifact" },
  { label: "Visuals", value: "html" },
];

/**
 * Conversation-content search over one machine, or one thread when `threadId`
 * is set. A hit opens its thread at the matched history window without
 * replacing the live tail; canceled searches never overwrite newer results.
 * Mirrors iOS `ConversationSearchView` (`apps/ios/Sources/Views/Search/ConversationSearchView.swift`).
 */
export function ConversationSearchView({
  client,
  threadId,
  open,
}: {
  client: ClientApi;
  threadId?: string | undefined;
  open(threadId: string, title: string, itemId?: string): void;
}) {
  const theme = useTheme();
  const model = useMemo(() => new ConversationSearch(), []);
  const snapshot = useSelection(model.selection);
  const connection = useSelection(useMemo(() => client.connectionState(), [client]));
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ConversationSearchKind>("");
  useEffect(() => {
    // Mirror the iOS `queryKey`: a reconnect re-runs the query so an offline
    // search retries once the machine is ready again.
    if (connection !== "ready" && !text.trim()) model.cancel();
    else void model.search(client, text, kind, threadId);
    return () => model.cancel();
  }, [model, client, text, kind, threadId, connection]);
  useEffect(() => () => model.cancel(), [model]);
  return (
    <View style={{ flex: 1, backgroundColor: theme.colours.background }}>
      <TextInput
        accessibilityLabel="Search conversations"
        placeholder="Search messages, tools and files"
        placeholderTextColor={theme.colours.mutedForeground}
        selectionColor={theme.colours.accent}
        cursorColor={theme.colours.accent}
        underlineColorAndroid="transparent"
        value={text}
        onChangeText={setText}
        returnKeyType="search"
        style={{
          ...textStyle("body"),
          color: theme.colours.foreground,
          backgroundColor: theme.colours.card,
          borderRadius: tokens.radii.composer,
          borderWidth: tokens.dimensions.border,
          borderColor: theme.colours.separator,
          marginHorizontal: tokens.spacing.lg,
          marginVertical: tokens.spacing.sm,
          paddingHorizontal: tokens.spacing.md,
          minHeight: tokens.dimensions.touchTarget,
        }}
      />
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: tokens.spacing.xs,
          paddingHorizontal: tokens.spacing.lg,
          paddingBottom: tokens.spacing.sm,
        }}
      >
        {KINDS.map((option) => {
          const selected = kind === option.value;
          return (
            <Pressable
              key={option.label}
              accessibilityRole="button"
              accessibilityLabel={`Search in ${option.label}`}
              accessibilityState={{ selected }}
              onPress={() => setKind(option.value)}
              style={{
                paddingHorizontal: tokens.spacing.md,
                paddingVertical: tokens.spacing.xs,
                borderRadius: tokens.radii.pill,
                backgroundColor: selected ? theme.colours.foreground : theme.colours.fill,
              }}
            >
              <Text
                style={{
                  ...textStyle("caption"),
                  color: selected ? theme.colours.background : theme.colours.foreground,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {snapshot.problem ? (
        <View style={{ paddingHorizontal: tokens.spacing.lg, paddingVertical: tokens.spacing.sm }}>
          <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
            {snapshot.problem}
          </Text>
          <View style={{ paddingTop: tokens.spacing.sm }}>
            <AceHost style={{ width: "100%" }}>
              <AceButton
                label="Retry search"
                kind="secondary"
                onPress={() => void model.search(client, text, kind, threadId)}
              />
            </AceHost>
          </View>
        </View>
      ) : null}
      {snapshot.loading && snapshot.hits.length === 0 ? (
        <Text
          accessibilityLabel="Searching conversations"
          style={{
            ...textStyle("body"),
            color: theme.colours.mutedForeground,
            padding: tokens.spacing.lg,
          }}
        >
          Searching conversations…
        </Text>
      ) : null}
      {!snapshot.loading && snapshot.loaded && snapshot.hits.length === 0 && !snapshot.problem ? (
        <Text
          style={{
            ...textStyle("body"),
            color: theme.colours.mutedForeground,
            padding: tokens.spacing.lg,
          }}
        >
          {text.trim()
            ? `No results for “${text.trim()}”.`
            : "Type to search this machine's conversations."}
        </Text>
      ) : null}
      <FlatList
        data={[...snapshot.hits]}
        keyExtractor={hitId}
        renderItem={({ item }) => (
          <HitRow hit={item} onOpen={() => open(item.threadId, item.threadTitle, item.itemId)} />
        )}
        ListFooterComponent={
          snapshot.cursor ? (
            <View style={{ padding: tokens.spacing.lg }}>
              <AceHost style={{ width: "100%" }}>
                <AceButton
                  label="Show more results"
                  kind="secondary"
                  enabled={!snapshot.loading}
                  onPress={() => void model.more(client, text, kind, threadId)}
                />
              </AceHost>
            </View>
          ) : null
        }
      />
    </View>
  );
}

function HitRow({ hit, onOpen }: { hit: ConversationHit; onOpen(): void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Search result ${hitId(hit)}`}
      onPress={onOpen}
      style={{
        paddingHorizontal: tokens.spacing.lg,
        paddingVertical: tokens.spacing.sm,
        borderBottomWidth: tokens.dimensions.border,
        borderBottomColor: theme.colours.separator,
        minHeight: tokens.dimensions.touchTarget,
        justifyContent: "center",
      }}
    >
      <Text style={{ ...textStyle("rowTitle"), color: theme.colours.foreground }} numberOfLines={2}>
        {hit.threadTitle}
      </Text>
      <Text
        style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}
        numberOfLines={3}
      >
        {hitExcerpt(hit)}
      </Text>
      <Text style={{ ...textStyle("caption"), color: theme.colours.subtleForeground }}>
        {`${hit.provider} · ${hit.kind.replace(/_/g, " ")}`}
      </Text>
    </Pressable>
  );
}
