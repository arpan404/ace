import { useMemo, useEffect, memo, useState } from "react";
import { View, Text, KeyboardAvoidingView } from "react-native";
import { FlashList } from "@shopify/flash-list";
import type { ClientApi, ThreadSource } from "@ace/client";
import { useSelection, sameIds } from "./selection.ts";
import { useTheme, tokens, textStyle, AceHost } from "./theme.tsx";
import { Approval } from "./Approval.tsx";
import { Composer } from "./Composer.tsx";
import { AceText, AceButton, Row, StatusPill } from "./components.tsx";
import { statusAppearance } from "./status.ts";
import { AgentsSheet } from "./sheets.tsx";

const TranscriptRow = memo(function TranscriptRow({
  id,
  store,
}: {
  id: string;
  store: ThreadSource;
}) {
  const theme = useTheme();
  const selection = useMemo(() => store.select([`item:${id}`], (r) => r.item(id)), [store, id]);
  const item = useSelection(selection);
  if (!item) return null;
  let text: string;
  let user = false;
  if (item.type === "message") {
    text = item.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    user = item.role === "user";
  } else if (item.type === "reasoning") text = "Thinking…";
  else if (item.type === "tool_call") text = `${item.call.title} · ${item.call.status}`;
  else if (item.type === "notice") text = item.text;
  else if (item.type === "delegation.started") text = `${item.title} · ${item.status.state}`;
  else text = item.type.replaceAll("_", " ");
  return (
    <View
      style={{
        marginHorizontal: tokens.spacing.lg,
        marginVertical: tokens.spacing.sm,
        alignSelf: user ? "flex-end" : "stretch",
        maxWidth: user ? "85%" : "100%",
        backgroundColor: user ? theme.colours.secondaryBackground : theme.colours.background,
        borderRadius: tokens.radii.bubble,
        padding: user ? tokens.spacing.md : 0,
      }}
    >
      <Text
        style={{
          ...textStyle(item.type === "tool_call" ? "caption" : "body"),
          color: theme.colours.foreground,
        }}
      >
        {text}
        {item.complete ? "" : " ▍"}
      </Text>
    </View>
  );
});
export function ThreadScreen({
  client,
  id,
  notify,
}: {
  client: ClientApi;
  id: string;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const [agents, setAgents] = useState(false);
  const lease = useMemo(() => client.thread(id), [client, id]);
  useEffect(() => () => lease.release(), [lease]);
  const orderSelection = useMemo(() => lease.store.select(["order"], (r) => r.order), [lease]);
  const threadSelection = useMemo(() => lease.store.select(["thread"], (r) => r.thread), [lease]);
  const interactionsSelection = useMemo(
    () => lease.store.select(["interactions"], (r) => r.interactionIds(), sameIds),
    [lease],
  );
  const pendingSelection = useMemo(() => client.pendingSends(id), [client, id]);
  const scopedError = useSelection(
    useMemo(() => lease.store.select(["error"], (r) => r.error), [lease]),
  );
  const connection = useSelection(useMemo(() => client.connectionState(), [client]));
  const ids = useSelection(orderSelection);
  const thread = useSelection(threadSelection);
  const interactions = useSelection(interactionsSelection);
  const pending = useSelection(pendingSelection);
  const status = thread ? statusAppearance(thread.status, theme) : undefined;
  // Loaded admission rows replace local echoes under input:<commandId>; never show both.
  const unsent = pending.filter((p) => !ids.includes(p.itemId) && p.state !== "delivered");
  async function stressHistory() {
    try {
      for (let page = 0; page < 10 && lease.store.itemsBefore !== null; page++)
        await client.loadOlder(id, 200);
      console.info("AceSpikeHistory", JSON.stringify({ items: lease.store.order.length }));
      notify(`${lease.store.order.length} loaded entries`);
    } catch {
      notify("History could not be loaded");
    }
  }
  async function older() {
    try {
      await client.loadOlder(id, 200);
    } catch {
      notify("Older messages could not be loaded");
    }
  }
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <View style={{ paddingHorizontal: tokens.spacing.lg, paddingVertical: tokens.spacing.sm }}>
        <AceHost style={{ width: "100%" }}>
          <Row horizontalArrangement="spaceBetween">
            {status ? (
              <StatusPill {...status} />
            ) : (
              <AceText>
                {scopedError
                  ? `Transcript unavailable (${scopedError.code})`
                  : `Loading · ${connection}`}
              </AceText>
            )}
            {__DEV__ ? (
              <AceButton
                label="Load 2,000"
                enabled={!!thread}
                onPress={() => void stressHistory()}
                kind="secondary"
              />
            ) : null}
            <AceButton label="Agents" onPress={() => setAgents(true)} kind="secondary" />
          </Row>
        </AceHost>
      </View>
      <FlashList
        data={ids}
        keyExtractor={(item) => item}
        renderItem={({ item }) => <TranscriptRow id={item} store={lease.store} />}
        getItemType={(item) => lease.store.item(item)?.type ?? "unknown"}
        maintainVisibleContentPosition={{
          autoscrollToBottomThreshold: 0.1,
          startRenderingFromBottom: true,
        }}
        ListHeaderComponent={
          <AceHost>
            <Row>
              <AceButton label="Earlier messages" onPress={() => void older()} kind="secondary" />
              {__DEV__ ? (
                <AceButton
                  label="Load 2,000"
                  onPress={() => void stressHistory()}
                  kind="secondary"
                />
              ) : null}
            </Row>
          </AceHost>
        }
        ListFooterComponent={
          <View>
            {unsent.map((p) => (
              <View
                key={p.itemId}
                style={{
                  padding: tokens.spacing.md,
                  margin: tokens.spacing.md,
                  backgroundColor: theme.colours.secondaryBackground,
                  borderRadius: tokens.radii.bubble,
                }}
              >
                <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
                  {p.payload.input
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("")}
                </Text>
                <Text
                  style={{
                    ...textStyle("caption"),
                    color:
                      p.state === "failed"
                        ? theme.statusText.failed
                        : theme.colours.mutedForeground,
                  }}
                >
                  {p.state === "failed"
                    ? p.error
                    : p.waiting
                      ? "Will send when reconnected"
                      : p.state}
                </Text>
              </View>
            ))}
          </View>
        }
      />
      {interactions.map((interaction) => (
        <View key={interaction} style={{ marginHorizontal: tokens.dimensions.composerInset }}>
          <Approval id={interaction} store={lease.store} client={client} notify={notify} />
        </View>
      ))}
      <Composer threadId={id} client={client} notify={notify} />
      {agents ? (
        <AgentsSheet
          store={lease.store}
          client={client}
          dismiss={() => setAgents(false)}
          notify={notify}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
