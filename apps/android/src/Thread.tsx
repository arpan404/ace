import { useMemo, useEffect, memo, useState } from "react";
import { View, Text } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useHeaderHeight } from "@react-navigation/elements";
import { FlashList } from "@shopify/flash-list";
import type { ClientApi, ThreadSource } from "@ace/client";
import type { Item } from "@ace/protocol";
import { useSelection, sameIds } from "./selection.ts";
import { isInstrumentedBuild } from "./native-mode.ts";
import { useTheme, tokens, textStyle, AceHost } from "./theme.tsx";
import { Approval } from "./Approval.tsx";
import { Composer } from "./Composer.tsx";
import { AceText, AceButton, Row, StatusPill } from "./components.tsx";
import { statusAppearance } from "./status.ts";
import { draftKey } from "./thread-drafts.ts";
import type { ThreadDraftStore } from "./thread-drafts.ts";
import { transcriptRowContent } from "@ace/ui-core/mobile";
import { startedThreadOf } from "@ace/ui-core";
import { blockItems, type Block } from "@ace/ui-core/transcript-blocks";
import { AgentsSheet } from "./sheets.tsx";
import {
  blockKey,
  blockTestId,
  endBlockText,
  forkedBlockText,
  startedBlockText,
  useTranscriptBlocks,
} from "./transcript.ts";

function itemText(item: Item | undefined): { text: string; detail: string; streaming: boolean } {
  if (!item) return { text: "", detail: "", streaming: false };
  const { text, detail } = transcriptRowContent(item);
  return { text, detail, streaming: !item.complete };
}

const BlockItemText = memo(function BlockItemText({
  id,
  store,
  quiet,
}: {
  id: string;
  store: ThreadSource;
  quiet?: boolean;
}) {
  const theme = useTheme();
  const selection = useMemo(() => store.select([`item:${id}`], (r) => r.item(id)), [store, id]);
  const item = useSelection(selection);
  const { text, detail, streaming } = itemText(item);
  if (!text && !detail) return null;
  return (
    <View>
      <Text
        style={{
          ...textStyle(quiet ? "caption" : "body"),
          color: quiet ? theme.colours.mutedForeground : theme.colours.foreground,
        }}
      >
        {text}
        {streaming ? " ▍" : ""}
      </Text>
      {detail ? (
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
});

const EndBlockRow = memo(function EndBlockRow({
  block,
  store,
}: {
  block: Extract<Block, { kind: "end" }>;
  store: ThreadSource;
}) {
  const theme = useTheme();
  const errorSelection = useMemo(
    () =>
      store.select(block.errorId ? [`item:${block.errorId}` as const] : [], (r) =>
        block.errorId ? r.item(block.errorId) : undefined,
      ),
    [store, block.errorId],
  );
  const errorItem = useSelection(errorSelection);
  const errorText = errorItem ? transcriptRowContent(errorItem).text : "";
  const label = endBlockText(block);
  return (
    <View
      style={{
        marginHorizontal: tokens.spacing.lg,
        marginVertical: tokens.spacing.sm,
        alignItems: "center",
      }}
    >
      <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
        {errorText ? `${label} — ${errorText}` : label}
      </Text>
    </View>
  );
});

const TranscriptBlockRow = memo(function TranscriptBlockRow({
  block,
  store,
}: {
  block: Block;
  store: ThreadSource;
}) {
  const theme = useTheme();
  const ids = useMemo(() => blockItems(block), [block]);
  const firstSelection = useMemo(
    () =>
      store.select(
        ids.map((id) => `item:${id}` as const),
        (r) => ids.map((id) => r.item(id)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, ids.join("\0")],
  );
  const firstItems = useSelection(firstSelection);
  if (block.kind === "user") {
    const item = firstItems[0];
    const { text, streaming } = itemText(item);
    if (!text) return null;
    return (
      <View
        style={{
          marginHorizontal: tokens.spacing.lg,
          marginVertical: tokens.spacing.sm,
          alignSelf: "flex-end",
          maxWidth: "85%",
          backgroundColor: theme.colours.secondaryBackground,
          borderRadius: tokens.radii.bubble,
          padding: tokens.spacing.md,
        }}
      >
        <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
          {text}
          {streaming ? " ▍" : ""}
        </Text>
      </View>
    );
  }
  if (block.kind === "message") {
    const item = firstItems[0];
    const { text, detail, streaming } = itemText(item);
    if (!text && !detail) return null;
    return (
      <View style={{ marginHorizontal: tokens.spacing.lg, marginVertical: tokens.spacing.sm }}>
        <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
          {text}
          {streaming ? " ▍" : ""}
        </Text>
        {detail ? (
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            {detail}
          </Text>
        ) : null}
      </View>
    );
  }
  if (block.kind === "event" || block.kind === "item") {
    return (
      <View style={{ marginHorizontal: tokens.spacing.lg, marginVertical: tokens.spacing.sm }}>
        {ids.map((id) => (
          <BlockItemText key={id} id={id} store={store} quiet />
        ))}
      </View>
    );
  }
  if (block.kind === "end") {
    return <EndBlockRow block={block} store={store} />;
  }
  if (block.kind === "forked") {
    return (
      <View
        style={{
          marginHorizontal: tokens.spacing.lg,
          marginVertical: tokens.spacing.sm,
          alignItems: "center",
        }}
      >
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {forkedBlockText(block.threadId)}
        </Text>
      </View>
    );
  }
  if (block.kind === "started") {
    const item = firstItems[0];
    const title = startedThreadOf(item)?.title;
    return (
      <View style={{ marginHorizontal: tokens.spacing.lg, marginVertical: tokens.spacing.sm }}>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {startedBlockText(title)}
        </Text>
      </View>
    );
  }
  if (block.kind === "live") {
    // iOS parity (TranscriptBlocks.swift renders live as EmptyView): the live
    // state is the status pill over the composer, not a line in the transcript.
    return null;
  }
  if (block.kind === "question") {
    return (
      <View style={{ marginHorizontal: tokens.spacing.lg, marginVertical: tokens.spacing.sm }}>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          Waiting on your answer
        </Text>
      </View>
    );
  }
  return (
    <View style={{ marginHorizontal: tokens.spacing.lg, marginVertical: tokens.spacing.sm }}>
      {ids.map((id) => (
        <BlockItemText key={id} id={id} store={store} quiet />
      ))}
    </View>
  );
});
export function ThreadScreen({
  client,
  id,
  hostId,
  drafts,
  notify,
}: {
  client: ClientApi;
  id: string;
  /** Owning machine; null keeps unsent words only while the thread is shown. */
  hostId: string | null;
  drafts: ThreadDraftStore | null;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const headerHeight = useHeaderHeight();
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
  const blocks = useTranscriptBlocks(lease.store);
  const thread = useSelection(threadSelection);
  const interactions = useSelection(interactionsSelection);
  const pending = useSelection(pendingSelection);
  const status = thread ? statusAppearance(thread.status, theme) : undefined;
  // Stress controls exist only in fixture builds; measurement also needs them
  // even though __DEV__ is false there. Production fails closed to no controls.
  const instrumented = useMemo(() => isInstrumentedBuild(), []);
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
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
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
            {instrumented ? (
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
        style={{ flex: 1 }}
        data={blocks}
        keyExtractor={(item) => blockKey(item)}
        renderItem={({ item }) => <TranscriptBlockRow block={item} store={lease.store} />}
        getItemType={(item) => `${item.kind}:${blockTestId(item)}`}
        maintainVisibleContentPosition={{
          autoscrollToBottomThreshold: 0.1,
          startRenderingFromBottom: true,
        }}
        ListHeaderComponent={
          <AceHost>
            <Row>
              <AceButton label="Earlier messages" onPress={() => void older()} kind="secondary" />
              {instrumented ? (
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
      <Composer
        threadId={id}
        draftKey={hostId === null ? null : draftKey(hostId, id)}
        drafts={drafts}
        client={client}
        notify={notify}
      />
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
