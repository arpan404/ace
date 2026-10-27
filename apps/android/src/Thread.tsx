import { useMemo, useEffect, useRef, useCallback, memo, useState } from "react";
import { View, Text } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useHeaderHeight } from "@react-navigation/elements";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import type { ClientApi, ThreadSource } from "@ace/client";
import type { Item } from "@ace/protocol";
import { readHistoryWindow } from "./conversation-search.ts";
import { useSelection, sameIds } from "./selection.ts";
import { isInstrumentedBuild } from "./native-mode.ts";
import { useTheme, tokens, textStyle, AceHost } from "./theme.tsx";
import { Approval } from "./Approval.tsx";
import { Questions } from "./Questions.tsx";
import { Composer } from "./Composer.tsx";
import { AceText, AceButton, Row, StatusPill } from "./components.tsx";
import { statusAppearance } from "./status.ts";
import { draftKey } from "./thread-drafts.ts";
import type { ThreadDraftStore } from "./thread-drafts.ts";
import { Markdown } from "./transcript/Markdown.tsx";
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
        {text ? <Markdown text={text} streaming={streaming} /> : null}
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
const HistoryWindow = memo(function HistoryWindow({
  history,
  dismiss,
  retry,
}: {
  history: { target: string; items: readonly Item[]; loading: boolean; problem?: string };
  dismiss(): void;
  retry(): void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        marginHorizontal: tokens.spacing.lg,
        marginVertical: tokens.spacing.sm,
        padding: tokens.spacing.md,
        backgroundColor: theme.colours.card,
        borderRadius: tokens.radii.bubble,
        borderWidth: tokens.dimensions.border,
        borderColor: theme.colours.separator,
      }}
    >
      <AceHost style={{ width: "100%" }}>
        <Row horizontalArrangement="spaceBetween">
          <AceText role="label">Matched history</AceText>
          <AceButton label="Jump to latest" kind="secondary" onPress={dismiss} />
        </Row>
      </AceHost>
      {history.loading ? (
        <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}>
          Opening the match…
        </Text>
      ) : history.problem ? (
        <View style={{ gap: tokens.spacing.sm }}>
          <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
            {history.problem}
          </Text>
          <AceHost style={{ width: "100%" }}>
            <AceButton label="Retry" kind="secondary" onPress={retry} />
          </AceHost>
        </View>
      ) : (
        history.items.map((item) => (
          <HistoryRow key={item.id} item={item} target={history.target} />
        ))
      )}
    </View>
  );
});

function HistoryRow({ item, target }: { item: Item; target: string }) {
  const theme = useTheme();
  const { text, detail, user, quiet } = transcriptRowContent(item);
  const matched = item.id === target;
  return (
    <View
      style={{
        marginVertical: tokens.spacing.xs,
        alignSelf: user ? "flex-end" : "stretch",
        maxWidth: user ? "85%" : "100%",
        backgroundColor: matched ? theme.colours.fill : theme.colours.secondaryBackground,
        borderRadius: tokens.radii.bubble,
        padding: tokens.spacing.md,
      }}
    >
      <Text
        style={{
          ...textStyle(quiet ? "caption" : "body"),
          color: theme.colours.foreground,
        }}
      >
        {text}
      </Text>
      {detail ? (
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

function isHistoryAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export function ThreadScreen({
  client,
  id,
  focusItemId,
  hostId,
  drafts,
  notify,
  onOpenFiles,
  returnSends = false,
}: {
  client: ClientApi;
  id: string;
  focusItemId?: string | undefined;
  /** Owning machine; null keeps unsent words only while the thread is shown. */
  hostId: string | null;
  drafts: ThreadDraftStore | null;
  notify(text: string): void;
  onOpenFiles?(): void;
  returnSends?: boolean;
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
  const listRef = useRef<FlashListRef<Block> | null>(null);
  type HistoryState = {
    target: string;
    items: readonly Item[];
    loading: boolean;
    problem?: string;
  };
  const [history, setHistory] = useState<HistoryState | null>(() =>
    focusItemId ? { target: focusItemId, items: [], loading: true } : null,
  );
  // A search hit opens its history window beside the live tail: this bounded
  // `itemsWindow` read never replaces the leased tail. Each fetch owns an
  // `AbortController` so dismissing the window or leaving the thread cancels
  // the pending request; the sequence guard ignores late replies after
  // dismissal or a route change so they cannot corrupt the newly opened
  // thread. The window renders in the list header above the live tail, so it
  // is scrolled into view once loaded instead of sitting off-screen.
  const historySeq = useRef(0);
  const historyCtrl = useRef<AbortController | null>(null);
  const loadHistory = useCallback(
    (target: string) => {
      const seq = (historySeq.current += 1);
      historyCtrl.current?.abort();
      const ctrl = new AbortController();
      historyCtrl.current = ctrl;
      void (async () => {
        try {
          const items = await readHistoryWindow(client, id, target, {
            signal: ctrl.signal,
          });
          if (historyCtrl.current !== ctrl || historySeq.current !== seq || ctrl.signal.aborted)
            return;
          setHistory({ target, items, loading: false });
        } catch (error) {
          if (historyCtrl.current !== ctrl || historySeq.current !== seq) return;
          if (ctrl.signal.aborted || isHistoryAbort(error)) return;
          notify("That match could not be opened");
          setHistory({
            target,
            items: [],
            loading: false,
            problem: "That match could not be opened.",
          });
        }
      })();
    },
    [client, id, notify],
  );
  const retryHistory = useCallback(
    (target: string) => {
      setHistory({ target, items: [], loading: true });
      loadHistory(target);
    },
    [loadHistory],
  );
  useEffect(() => {
    // A pushed search hit always mounts with its `focusItemId`, so the
    // initial state above already shows its loading row while this fetches.
    if (focusItemId) loadHistory(focusItemId);
    // Leaving the thread (or unmounting) cancels the pending history read.
    return () => {
      historySeq.current += 1;
      historyCtrl.current?.abort();
      historyCtrl.current = null;
    };
  }, [focusItemId, loadHistory]);
  useEffect(() => {
    // The window renders in the list header above the live tail: once loaded,
    // bring it into view instead of leaving it off-screen at the top.
    if (history !== null && !history.loading)
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [history]);
  const dismissHistory = useCallback(() => {
    historySeq.current += 1;
    historyCtrl.current?.abort();
    historyCtrl.current = null;
    setHistory(null);
    listRef.current?.scrollToEnd({ animated: true });
  }, []);
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
            {onOpenFiles ? (
              <AceButton label="Files" onPress={onOpenFiles} kind="secondary" />
            ) : null}
          </Row>
        </AceHost>
      </View>
      <FlashList
        ref={listRef}
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
          <>
            {history ? (
              <HistoryWindow
                history={history}
                dismiss={dismissHistory}
                retry={() => retryHistory(history.target)}
              />
            ) : null}
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
          </>
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
          <Questions id={interaction} store={lease.store} client={client} notify={notify} />
        </View>
      ))}
      <Composer
        threadId={id}
        draftKey={hostId === null ? null : draftKey(hostId, id)}
        drafts={drafts}
        client={client}
        notify={notify}
        returnSends={returnSends}
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
