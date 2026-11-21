import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import type { Selection, ThreadKey, ThreadReader, ThreadSource } from "@ace/client";
import type { Item } from "@ace/protocol";
import { transcriptRowContent } from "@ace/ui-core/mobile";
import { approvalCopy, approvalOutcome, startedThreadOf } from "@ace/ui-core";
import { blocksEqual, type Block } from "@ace/ui-core/transcript-blocks";
import { createBlockReader, type Watched } from "@ace/ui-core/transcript-block-reader";
import {
  blockKey,
  blockTestId,
  endBlockText,
  forkedBlockText,
  startedBlockText,
} from "../transcript.ts";
import { Markdown } from "../transcript/Markdown.tsx";
import { sameIds } from "../selection.ts";
import { shellCommandForApproval } from "../interactions.ts";
import { browserHelpCardDetail, browserHelpCardTitle } from "./production-approvals.ts";
import { AceButton, AceText } from "../components.tsx";
import { textStyle, tokens, useTheme } from "../theme.tsx";
import {
  PRODUCTION_THREAD_WINDOW,
  THREAD_LIST_MAX_HEIGHT,
  THREAD_LIST_MIN_HEIGHT,
  noUndefinedList,
  readingFailureCopy,
  retryReading,
  shouldAutoRecoverReads,
  shouldPollAutoRecover,
  shouldResolveLease,
  shouldShowInbox,
  threadHeadlineFor,
  threadWindowFor,
  visibleBlockItemIds,
  windowBlocksFor,
} from "./production-inbox.ts";
import { canShowProductionComposer } from "./production-composer.ts";
import { ProductionComposer } from "./production-composer.tsx";
import { FileScreen, FilesScreen } from "../Files.tsx";
import { productionFilesClient } from "./production-files.ts";
import {
  ProductionInteractionStrip,
  isCoveredProductionInteraction,
  usePendingProductionInteractionIds,
} from "./production-approvals.tsx";
import type { ThreadDraftStore } from "../thread-drafts.ts";
import type { ProductionStartup } from "../runtime/production-startup.ts";
import {
  EMPTY_ORDER,
  FALLBACK_HEADLINE,
  emptySelection,
  isDeadSelection,
  noConnection,
  noHeadline,
  noOrder,
  noUndefined,
  useFailClosedSelection,
  useLivenessTick,
} from "./production-inbox-common.tsx";

const PRODUCTION_BLOCK_BASE_KEYS: readonly ThreadKey[] = [
  "order",
  "thread",
  "agents",
  "tasks",
  "interactions",
  "queue",
];
const PRODUCTION_BLOCK_NO_KEYS: readonly ThreadKey[] = [];
const EMPTY_BLOCKS: readonly Block[] = Object.freeze([]);
const noBlocksReading: Watched<readonly Block[]> = Object.freeze({
  value: EMPTY_BLOCKS,
  watch: PRODUCTION_BLOCK_NO_KEYS,
});

function sameBlockList(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((key, index) => key === b[index]));
}

function sameBlockReading(a: Watched<readonly Block[]>, b: Watched<readonly Block[]>): boolean {
  return blocksEqual(a.value, b.value) && sameBlockList(a.watch, b.watch);
}

/**
 * Fail-closed transcript blocks for the production read-only thread.
 *
 * Mirrors the fixture `useTranscriptBlocks` grouping (same shared block
 * engine, same watch-key protocol) but never throws: a revoked pin fails
 * `select` synchronously and a dead pin fails `getSnapshot`, both falling
 * back to the empty reading so the caller paints its disconnected copy. No
 * admit path, no network fetch, no mutation — only the retained read lease's
 * projected store. One reader serves one store; a host/thread switch mounts
 * a fresh reader with no watch keys from the old one.
 */
function useProductionBlocks(store: ThreadSource): readonly Block[] {
  const [held, setHeld] = useState(() => ({ store, read: createBlockReader() }));
  if (held.store !== store) setHeld({ store, read: createBlockReader() });
  const read = held.read;
  let owner: string | undefined;
  try {
    owner = store.thread?.rootAgentId;
  } catch {
    owner = undefined;
  }
  const base = useMemo<readonly ThreadKey[]>(
    () =>
      owner ? [...PRODUCTION_BLOCK_BASE_KEYS, `agent:${owner}`] : [...PRODUCTION_BLOCK_BASE_KEYS],
    [owner],
  );
  const [watch, setWatch] = useState<readonly ThreadKey[]>(PRODUCTION_BLOCK_NO_KEYS);
  const [scoped, setScoped] = useState(store);
  if (scoped !== store) {
    setScoped(store);
    if (watch.length) setWatch(PRODUCTION_BLOCK_NO_KEYS);
  }
  const keys = useMemo(() => [...base, ...watch], [base, watch]);
  const selection = useMemo(() => {
    try {
      return store.select(keys, (reader: ThreadReader) => read(reader), sameBlockReading);
    } catch {
      return null;
    }
  }, [store, keys, read]);
  const fallbackSelection = useMemo<Selection<Watched<readonly Block[]>>>(
    () => ({
      getSnapshot: () => noBlocksReading,
      subscribe: () => () => {},
    }),
    [],
  );
  const reading = useFailClosedSelection(selection ?? fallbackSelection, noBlocksReading);
  const next = reading.watch as readonly ThreadKey[];
  if (!sameBlockList(next, watch)) setWatch(next);
  return reading.value;
}

function itemText(item: Item | undefined): { text: string; detail: string; streaming: boolean } {
  if (!item) return { text: "", detail: "", streaming: false };
  const { text, detail } = transcriptRowContent(item);
  return { text, detail, streaming: !item.complete };
}

function ProductionQuietLines({ ids, store }: { ids: readonly string[]; store: ThreadSource }) {
  const theme = useTheme();
  const selection = useMemo(() => {
    try {
      return store.select(
        ids.map((id) => `item:${id}` as const),
        (r) => ids.map((id) => r.item(id)),
      );
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ids.join("\0")]);
  const items = useFailClosedSelection(selection ?? noUndefinedList, undefined);
  if (!items) return null;
  const lines = items.flatMap((item) => {
    if (!item) return [];
    const { text, detail } = transcriptRowContent(item);
    if (!text && !detail) return [];
    return [{ id: item.id, text, detail }];
  });
  if (lines.length === 0) return null;
  return (
    <View style={{ gap: tokens.spacing.xs }}>
      {lines.map(({ id, text, detail }) => (
        <View key={id}>
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            {text}
          </Text>
          {detail ? (
            <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
              {detail}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function ProductionStartedRow({ itemId, store }: { itemId: string; store: ThreadSource }) {
  const theme = useTheme();
  const selection = useMemo(() => {
    try {
      return store.select([`item:${itemId}`], (r) => r.item(itemId));
    } catch {
      return null;
    }
  }, [store, itemId]);
  const item = useFailClosedSelection(selection ?? noUndefined, undefined);
  const title = startedThreadOf(item)?.title;
  return (
    <View style={{ marginHorizontal: tokens.spacing.lg, marginVertical: tokens.spacing.sm }}>
      <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
        {startedBlockText(title)}
      </Text>
    </View>
  );
}

function ProductionEndRow({
  block,
  store,
}: {
  block: Extract<Block, { kind: "end" }>;
  store: ThreadSource;
}) {
  const theme = useTheme();
  const selection = useMemo(() => {
    try {
      return store.select(block.errorId ? [`item:${block.errorId}` as const] : [], (r) =>
        block.errorId ? r.item(block.errorId) : undefined,
      );
    } catch {
      return null;
    }
  }, [store, block.errorId]);
  const errorItem = useFailClosedSelection(selection ?? noUndefined, undefined);
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
}

/**
 * Read-only question/approval card for the production viewer. Subscribes to
 * the interaction ledger so the person can read what is being asked, but
 * offers no admit path: answering stays on the computer (a separate approval
 * action owns admission). Fail-closed to the historic waiting copy.
 */
function ProductionQuestionRow({
  interactionId,
  store,
  covered,
}: {
  interactionId: string;
  store: ThreadSource;
  covered?: ReadonlySet<string> | undefined;
}) {
  const theme = useTheme();
  const selection = useMemo(() => {
    try {
      return store.select([`interaction:${interactionId}`], (r) => r.interaction(interactionId));
    } catch {
      return null;
    }
  }, [store, interactionId]);
  const interaction = useFailClosedSelection(selection ?? noUndefined, undefined);
  const toolCallId = interaction?.toolCallId ?? "";
  const toolSelection = useMemo(() => {
    if (!toolCallId) return null;
    try {
      return store.select([`item:${toolCallId}`], (r) => r.item(toolCallId));
    } catch {
      return null;
    }
  }, [store, toolCallId]);
  const toolCall = useFailClosedSelection(toolSelection ?? noUndefined, undefined);
  if (covered !== undefined && isCoveredProductionInteraction(interaction, covered)) return null;
  if (!interaction) {
    return (
      <View style={{ marginHorizontal: tokens.spacing.lg, marginVertical: tokens.spacing.sm }}>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          Waiting on your answer
        </Text>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          View only. Reply on your computer.
        </Text>
      </View>
    );
  }
  const request = interaction.request;
  if (request.kind === "approval") {
    const command = shellCommandForApproval(toolCall);
    const copy = approvalCopy(request, command !== undefined ? { command } : {});
    const outcome = approvalOutcome(interaction);
    return (
      <View
        style={{
          marginHorizontal: tokens.spacing.lg,
          marginVertical: tokens.spacing.sm,
          gap: tokens.spacing.xs,
        }}
      >
        <Text style={{ ...textStyle("label"), color: theme.colours.foreground }}>
          Approval needed
        </Text>
        <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
          {copy.heading}
        </Text>
        {copy.command ? (
          <Text style={{ ...textStyle("caption"), color: theme.colours.foreground }}>
            $ {copy.command}
          </Text>
        ) : null}
        {copy.reason ? (
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            {copy.reason}
          </Text>
        ) : null}
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {outcome.text}
        </Text>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          View only. Reply on your computer.
        </Text>
      </View>
    );
  }
  if (request.kind === "question") {
    return (
      <View
        style={{
          marginHorizontal: tokens.spacing.lg,
          marginVertical: tokens.spacing.sm,
          gap: tokens.spacing.xs,
        }}
      >
        <Text style={{ ...textStyle("label"), color: theme.colours.foreground }}>Question</Text>
        {request.questions.map((question) => (
          <View key={question.id} style={{ gap: tokens.spacing.xs }}>
            <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
              {question.text}
            </Text>
            {question.options.map((option) => (
              <Text
                key={option.id}
                style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}
              >
                · {option.label}
              </Text>
            ))}
          </View>
        ))}
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {interaction.state === "pending" ? "Waiting on your answer" : "Answered"}
        </Text>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          View only. Reply on your computer.
        </Text>
      </View>
    );
  }
  if (request.kind === "browser_help") {
    // Historic copy only: pending rows are covered by the live strip card.
    // Title/detail reuse the shared iOS copy so history reads the same.
    const title = browserHelpCardTitle(request);
    const detail = browserHelpCardDetail(request);
    return (
      <View
        style={{
          marginHorizontal: tokens.spacing.lg,
          marginVertical: tokens.spacing.sm,
          gap: tokens.spacing.xs,
        }}
      >
        <Text style={{ ...textStyle("label"), color: theme.colours.foreground }}>{title}</Text>
        {detail ? (
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            {detail}
          </Text>
        ) : null}
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {interaction.state === "pending" ? "Waiting on your answer" : "Answered"}
        </Text>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          View only. Reply on your computer.
        </Text>
      </View>
    );
  }
  const title =
    request.kind === "plan_review"
      ? (request.title ?? "Plan review")
      : request.kind === "elicitation"
        ? (request.title ?? request.message)
        : "Request";
  return (
    <View
      style={{
        marginHorizontal: tokens.spacing.lg,
        marginVertical: tokens.spacing.sm,
        gap: tokens.spacing.xs,
      }}
    >
      <Text style={{ ...textStyle("label"), color: theme.colours.foreground }}>{title}</Text>
      <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
        {interaction.state === "pending" ? "Waiting on your answer" : "Answered"}
      </Text>
      <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
        View only. Reply on your computer.
      </Text>
    </View>
  );
}

const EMPTY_INTERACTION_IDS: readonly string[] = Object.freeze([]);
const noInteractionIds: Selection<readonly string[]> = emptySelection(EMPTY_INTERACTION_IDS);

/**
 * Ids of still-pending interactions, read-only. One membership selection
 * plus one N-key read keeps a pending question on an evicted anchor in the
 * window without subscribing per row. Fail-closed to empty (evicted-anchor
 * questions drop, matching the old behavior, instead of crashing).
 */
function useOpenQuestionIds(store: ThreadSource): ReadonlySet<string> {
  const idsSelection = useMemo(() => {
    try {
      return store.select(["interactions"], (r) => r.interactionIds(), sameIds);
    } catch {
      return null;
    }
  }, [store]);
  const ids = useFailClosedSelection(idsSelection ?? noInteractionIds, EMPTY_INTERACTION_IDS);
  const openSelection = useMemo(() => {
    try {
      return store.select(
        ids.map((id) => `interaction:${id}` as const),
        (r) =>
          ids.filter((id) => {
            try {
              return r.interaction(id)?.state === "pending";
            } catch {
              return false;
            }
          }),
        sameIds,
      );
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ids.join("\0")]);
  const open = useFailClosedSelection(openSelection ?? noInteractionIds, EMPTY_INTERACTION_IDS);
  return useMemo(() => new Set(open), [open]);
}

function ProductionBlockRow({
  block,
  store,
  shown,
  covered,
}: {
  block: Block;
  store: ThreadSource;
  shown: ReadonlySet<string>;
  covered?: ReadonlySet<string> | undefined;
}) {
  const theme = useTheme();
  if (block.kind === "end") {
    return <ProductionEndRow block={block} store={store} />;
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
    return <ProductionStartedRow itemId={block.itemId} store={store} />;
  }
  if (block.kind === "live") {
    return null;
  }
  if (block.kind === "question") {
    // No id-only suppression here: the row below owns the covered check
    // (`isCoveredProductionInteraction` requires pending + cardable kind +
    // covered id). Suppressing by id alone would hide resolved history for
    // a frame when `covered` lags `blocks`, and would mask future
    // non-cardable kinds if an id were reused.
    return (
      <ProductionQuestionRow interactionId={block.interactionId} store={store} covered={covered} />
    );
  }
  if (block.kind === "user") {
    if (!shown.has(block.itemId)) return null;
    return <ProductionUserBubble id={block.itemId} store={store} />;
  }
  if (block.kind === "message") {
    if (!shown.has(block.itemId)) return null;
    return <ProductionMessageBubble id={block.itemId} store={store} />;
  }
  const visible = visibleBlockItemIds(block, shown);
  if (visible.length === 0) return null;
  return (
    <View style={{ marginHorizontal: tokens.spacing.lg, marginVertical: tokens.spacing.sm }}>
      <ProductionQuietLines ids={visible} store={store} />
    </View>
  );
}

function ProductionUserBubble({ id, store }: { id: string; store: ThreadSource }) {
  const theme = useTheme();
  const selection = useMemo(() => {
    try {
      return store.select([`item:${id}`], (r) => r.item(id));
    } catch {
      return null;
    }
  }, [store, id]);
  const item = useFailClosedSelection(selection ?? noUndefined, undefined);
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

function ProductionMessageBubble({ id, store }: { id: string; store: ThreadSource }) {
  const theme = useTheme();
  const selection = useMemo(() => {
    try {
      return store.select([`item:${id}`], (r) => r.item(id));
    } catch {
      return null;
    }
  }, [store, id]);
  const item = useFailClosedSelection(selection ?? noUndefined, undefined);
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

function ThreadItems({
  store,
  covered,
}: {
  store: ThreadSource;
  covered?: ReadonlySet<string> | undefined;
}) {
  const theme = useTheme();
  const orderSelection = useMemo(() => {
    try {
      return store.select(["order"], (r) => r.order);
    } catch {
      return null;
    }
  }, [store]);
  const order = useFailClosedSelection(orderSelection ?? noOrder, EMPTY_ORDER);
  const blocks = useProductionBlocks(store);
  const openQuestions = useOpenQuestionIds(store);
  const window = useMemo(() => threadWindowFor(order, PRODUCTION_THREAD_WINDOW), [order]);
  const shown = useMemo(() => new Set(window.shown), [window]);
  const visible = useMemo(
    () => windowBlocksFor(blocks, shown, openQuestions),
    [blocks, shown, openQuestions],
  );
  if (window.total === 0) {
    return (
      <Text
        style={{
          ...textStyle("body"),
          color: theme.colours.mutedForeground,
          padding: tokens.spacing.xl,
        }}
      >
        No messages yet.
      </Text>
    );
  }
  return (
    <View
      style={{
        minHeight: THREAD_LIST_MIN_HEIGHT,
        maxHeight: THREAD_LIST_MAX_HEIGHT,
      }}
    >
      {window.truncated > 0 ? (
        <Text
          style={{
            ...textStyle("caption"),
            color: theme.colours.mutedForeground,
            paddingHorizontal: tokens.spacing.xl,
            paddingVertical: tokens.spacing.xs,
          }}
        >
          Showing the latest {window.shown.length} of {window.total} messages. Older history stays
          on your computer.
        </Text>
      ) : null}
      <FlashList
        data={visible}
        keyExtractor={(block: Block) => blockKey(block)}
        renderItem={({ item }: { item: Block }) => (
          <ProductionBlockRow block={item} store={store} shown={shown} covered={covered} />
        )}
        getItemType={(item: Block) => `${item.kind}:${blockTestId(item)}`}
        // Single scroll owner per region: the bounded window above owns this
        // region while the Machines screen owns page scroll. `flex:1` fills
        // the measured window (an unstyled list collapses); on Android the
        // gesture must be contained or the outer ScrollView steals it.
        // FlashList v2 has no estimatedItemSize prop: rows self-measure.
        style={{ flex: 1 }}
        nestedScrollEnabled
        maintainVisibleContentPosition={{
          autoscrollToBottomThreshold: 0.1,
          startRenderingFromBottom: true,
        }}
      />
    </View>
  );
}

function ProductionThreadContent({
  startup,
  hostId,
  store,
  notify,
}: {
  startup: ProductionStartup;
  hostId: string;
  store: ThreadSource;
  notify(text: string): void;
}) {
  const pendingIds = usePendingProductionInteractionIds(store);
  const covered = useMemo(() => new Set(pendingIds), [pendingIds]);
  return (
    <>
      <View>
        <ThreadItems store={store} covered={covered} />
      </View>
      {pendingIds.length > 0 ? (
        <View
          style={{
            paddingHorizontal: tokens.spacing.lg,
            paddingVertical: tokens.spacing.sm,
            gap: tokens.spacing.md,
          }}
        >
          <ProductionInteractionStrip
            startup={startup}
            hostId={hostId}
            store={store}
            interactionIds={pendingIds}
            notify={notify}
          />
        </View>
      ) : null}
    </>
  );
}

export function ProductionThreadView({
  startup,
  hostId,
  threadId,
  drafts,
  notify,
  onBack,
}: {
  startup: ProductionStartup;
  hostId: string;
  threadId: string;
  drafts: ThreadDraftStore | null;
  notify(text: string): void;
  onBack(): void;
}) {
  const theme = useTheme();
  const threadLiveness = useLivenessTick();
  const [retryTick, setRetryTick] = useState(0);
  const [autoRecoveries, setAutoRecoveries] = useState(0);
  // File viewer route: null paints the thread, `{}` its tree, `{path}` one file.
  // Read-only like the thread: the adapter below never exposes the raw client.
  const [fileRoute, setFileRoute] = useState<{ path?: string; line?: number } | null>(null);
  const filesScope = useMemo(() => ({ threadId }), [threadId]);
  const filesClient = useMemo(() => {
    try {
      return productionFilesClient(startup.runtimeForReading(hostId), threadId);
    } catch {
      return null;
    }
    // A fresh handle per host/thread; each read re-resolves the pin itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, threadId]);
  const threadRoute = startup.route(hostId);
  const routeBlocked = !shouldShowInbox(threadRoute);
  const resolvedLease = useMemo(() => {
    // Direct mount with a revoked route must not resolve (or keep) a lease:
    // returning null here releases any retained lease through the cleanup
    // below instead of holding revoked state until unmount.
    if (!shouldResolveLease(threadRoute)) return { lease: null, problem: null as string | null };
    try {
      return {
        lease: startup.runtimeForReading(hostId).thread(threadId),
        problem: null as string | null,
      };
    } catch (error) {
      return { lease: null, problem: readingFailureCopy(error) };
    }
    // Re-resolve on explicit retry, auto-recovery, or route flip; liveness ticks only re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, threadId, retryTick, routeBlocked]);
  const lease = resolvedLease.lease;
  const problem = resolvedLease.problem;
  useEffect(() => () => lease?.release(), [lease]);
  const headlineSelection = useMemo(() => {
    if (lease === null) return null;
    // Like the inbox list: an invalidated lease throws on `select` instead
    // of handing out a stale snapshot, so fall back to the fail-closed copy.
    try {
      return lease.store.select(["thread", "order"], (r) => threadHeadlineFor(r));
    } catch {
      return null;
    }
  }, [lease]);
  const headline = useFailClosedSelection(headlineSelection ?? noHeadline, FALLBACK_HEADLINE);
  const statusSelection = useMemo(() => {
    if (lease === null) return null;
    try {
      return lease.store.select(["thread"], (r) => r.thread?.status);
    } catch {
      return null;
    }
  }, [lease]);
  const statusValue = useFailClosedSelection(statusSelection ?? noUndefined, undefined);
  const connectionSelection = useMemo(() => {
    if (routeBlocked) return null;
    try {
      return startup.runtimeForReading(hostId).connectionState();
    } catch {
      return null;
    }
    // Re-resolve on explicit retry or auto-recovery; liveness ticks only re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, retryTick, routeBlocked]);
  // Subscribed (not just read): a disconnect notifies through the projection
  // and this view re-renders into the fail-closed copy immediately.
  const connection = useFailClosedSelection(connectionSelection ?? noConnection, "connecting");
  const dead =
    lease === null ||
    headlineSelection === null ||
    isDeadSelection(headlineSelection) ||
    isDeadSelection(statusSelection) ||
    connection !== "ready";
  // Auto-recovery where safe: when this view is fail-closed but a fresh read
  // handle already reports `ready`, re-resolve the lease. Revoked routes
  // never reach here (gated above); a transient blip recovers without Retry.
  // Bounded: a persistently dead lease stops after the budget and waits for
  // manual Retry instead of churning leases every tick.
  useEffect(() => {
    if (!dead || routeBlocked) return;
    if (!shouldPollAutoRecover(autoRecoveries)) return;
    let fresh: string | null = null;
    try {
      fresh = startup.runtimeForReading(hostId).connectionState().getSnapshot();
    } catch {
      return;
    }
    if (shouldAutoRecoverReads(true, fresh, autoRecoveries)) {
      setAutoRecoveries((value) => value + 1);
      setRetryTick((value) => value + 1);
    }
    // Poll on the liveness tick so a transient blip recovers without Retry.
    // `threadRoute` is a fresh object per read, so deps keep the stable
    // `routeBlocked` boolean only — never the route itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, dead, routeBlocked, threadLiveness, retryTick, autoRecoveries]);
  useEffect(() => {
    if (!dead) setAutoRecoveries(0);
  }, [dead]);
  function retry(): void {
    retryReading(startup, hostId);
    setAutoRecoveries(0);
    setRetryTick((value) => value + 1);
  }
  /** Header Back steps out of the file viewer first (file, then tree), then the thread. */
  function back(): void {
    if (fileRoute !== null) {
      if (fileRoute.path !== undefined) setFileRoute({});
      else setFileRoute(null);
    } else onBack();
  }
  const filesOpen = fileRoute !== null;
  if (routeBlocked) {
    return (
      <View style={{ flex: 1, padding: tokens.spacing.xl, gap: tokens.spacing.md }}>
        <AceButton label="Back" onPress={onBack} kind="secondary" />
        <AceText role="body">{threadRoute.route === "paired" ? null : threadRoute.message}</AceText>
      </View>
    );
  }
  if (
    dead &&
    (lease === null || headlineSelection === null || isDeadSelection(headlineSelection))
  ) {
    return (
      <View style={{ flex: 1, padding: tokens.spacing.xl, gap: tokens.spacing.md }}>
        <AceButton label="Back" onPress={onBack} kind="secondary" />
        <AceText role="body">{problem ?? "This machine is not connected."}</AceText>
        <AceButton label="Retry" onPress={retry} kind="secondary" />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, minHeight: THREAD_LIST_MIN_HEIGHT }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: tokens.spacing.md,
          paddingHorizontal: tokens.spacing.xl,
          paddingVertical: tokens.spacing.sm,
        }}
      >
        <AceButton label="Back" onPress={back} kind="secondary" />
        <Text
          style={{ ...textStyle("rowTitle"), color: theme.colours.foreground, flex: 1 }}
          numberOfLines={1}
        >
          {filesOpen ? (fileRoute.path ?? "Files") : (headline?.title ?? "Thread")}
        </Text>
        {filesOpen ? null : (
          <AceButton
            label="Files"
            onPress={() => setFileRoute({})}
            kind="secondary"
            enabled={filesClient !== null}
          />
        )}
      </View>
      {filesOpen && filesClient !== null ? (
        fileRoute.path === undefined ? (
          <FilesScreen
            client={filesClient}
            scope={filesScope}
            onOpenFile={(path, line) =>
              setFileRoute(line === undefined ? { path } : { path, line })
            }
            notify={notify}
          />
        ) : (
          <FileScreen
            client={filesClient}
            scope={filesScope}
            path={fileRoute.path}
            {...(fileRoute.line === undefined ? {} : { line: fileRoute.line })}
            notify={notify}
          />
        )
      ) : (
        <>
          {statusValue ? (
            <Text
              style={{
                ...textStyle("caption"),
                color: theme.colours.mutedForeground,
                paddingHorizontal: tokens.spacing.xl,
              }}
            >
              {statusValue.state} · {headline?.count ?? 0} messages
            </Text>
          ) : null}
          {connection !== "ready" ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: tokens.spacing.md,
                paddingHorizontal: tokens.spacing.xl,
                paddingVertical: tokens.spacing.xs,
              }}
            >
              <AceText role="caption">
                {connection === "connecting" ? "Connecting to your machine…" : `${connection}…`}
              </AceText>
              <AceButton label="Retry" onPress={retry} kind="secondary" />
            </View>
          ) : null}
          {lease === null ? null : (
            <ProductionThreadContent
              startup={startup}
              hostId={hostId}
              store={lease.store}
              notify={notify}
            />
          )}
          {canShowProductionComposer({
            canOperate: startup.canOperate(hostId),
            // Revoked/pin routes return above, so reaching here means paired.
            routePaired: true,
          }) ? (
            <ProductionComposer
              startup={startup}
              hostId={hostId}
              threadId={threadId}
              drafts={drafts}
              notify={notify}
            />
          ) : (
            <View style={{ padding: tokens.spacing.lg }}>
              <AceText role="caption" colour={theme.colours.mutedForeground}>
                View only. Reply on your computer.
              </AceText>
            </View>
          )}
        </>
      )}
    </View>
  );
}
