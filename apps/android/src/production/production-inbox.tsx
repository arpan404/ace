import { useEffect, useMemo, useState } from "react";
import { AppState, Pressable, View, Text } from "react-native";
import { FlashList } from "@shopify/flash-list";
import type { ConnectionState, Selection, SidebarSource, ThreadSource } from "@ace/client";
import { transcriptRowContent } from "@ace/ui-core/mobile";
import { inboxStatus } from "@ace/ui-core/mobile";
import { useSelection } from "../selection.ts";
import { AceText, AceButton } from "../components.tsx";
import { tokens, useTheme, textStyle } from "../theme.tsx";
import { displayAppearance } from "../status.ts";
import {
  INBOX_LIST_MAX_HEIGHT,
  INBOX_LIST_MIN_HEIGHT,
  PRODUCTION_THREAD_WINDOW,
  THREAD_LIST_MAX_HEIGHT,
  THREAD_LIST_MIN_HEIGHT,
  inboxEntriesFor,
  openIdForRoute,
  readingFailureCopy,
  resolveOpenIdForHost,
  retryReading,
  routeKeyFor,
  shouldAutoRecoverReads,
  shouldResolveLease,
  shouldShowInbox,
  threadHeadlineFor,
  threadWindowFor,
  type ProductionInboxEntry,
} from "./production-inbox.ts";
import { canShowProductionComposer } from "./production-composer.ts";
import { ProductionComposer } from "./production-composer.tsx";
import type { ThreadDraftStore } from "../thread-drafts.ts";
import type { ProductionStartup } from "../runtime/production-startup.ts";

/**
 * Production inbox for the active machine, read-only.
 *
 * Mirrors the iOS inbox read path (rows stay readable while view-only) over
 * the reviewed `runtimeForReading` handle: only selection leases, the
 * connection selection and cached snapshots escape, never the raw SDK
 * `Client` and never a mutating or network-fetching call. Every lease is
 * released when the view unmounts, the host changes, or the route leaves
 * `paired`; a cached handle that fails its exact-owner pin surfaces "not
 * connected" instead of following a new owner. No admit path lives here:
 * mutations stay behind `runtimeForMutation`, which this viewer never
 * resolves.
 *
 * Liveness. Projected selections notify on pin failure (see
 * `read-projection.ts`), so a disconnect re-renders through the normal
 * subscription. `getSnapshot` throws past the pin, which would crash
 * `useSyncExternalStore`, so every selection below is read through
 * `useFailClosedSelection`: a dead selection resolves to its fallback and the
 * view renders the fail-closed copy plus Retry. The startup route is plain
 * data (no subscription), so a lightweight tick re-reads it every 2s and on
 * foregrounding; a route flip re-resolves (and releases) the lease.
 */

function useNowTick(active: boolean, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/**
 * Re-render driver for unsubscribed reads (startup route, manager failure).
 * Polls lightly while mounted and bumps on foregrounding so background
 * disconnects, revocations and reconnects surface without waiting for the
 * 30s regroup tick. It only triggers renders: lease re-resolution keys on
 * the route identity, not on this tick, so no lease churn.
 */
function useLivenessTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 2000);
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") setTick((value) => value + 1);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return tick;
}

/**
 * Fail-closed selection read: a selection whose pin failed throws from
 * `getSnapshot`/`subscribe`. Return the fallback instead of crashing the
 * render, so the caller paints its disconnected copy. Hooks stay
 * unconditional; only the returned value switches.
 */
function useFailClosedSelection<T>(selection: Selection<T>, fallback: T): T {
  const safe = useMemo<Selection<T>>(
    () => ({
      getSnapshot: () => {
        try {
          return selection.getSnapshot();
        } catch {
          return fallback;
        }
      },
      subscribe: (listener: () => void) => {
        try {
          return selection.subscribe(listener);
        } catch {
          return () => {};
        }
      },
    }),
    [selection, fallback],
  );
  return useSelection(safe);
}

/** True when a live-created selection has since failed its pin. Sync, render-safe. */
function isDeadSelection(selection: Selection<unknown> | null): boolean {
  if (selection === null) return true;
  try {
    selection.getSnapshot();
    return false;
  } catch {
    return true;
  }
}

/**
 * Unconditional hook inputs for invalidated leases: every `select` above can
 * throw once the pin fails, but hooks cannot move, so a dead selection fills
 * in and the views below render the fail-closed copy instead.
 */
function emptySelection<T>(value: T): Selection<T> {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  };
}
const noOrder = emptySelection<readonly string[]>([]);
const noEntries = emptySelection<ProductionInboxEntry[] | undefined>(undefined);
const noConnection = emptySelection<ConnectionState>("connecting");

/**
 * Stable `useSyncExternalStore` inputs: every fallback/selection below keeps
 * one module identity so the 2s liveness tick re-render never resubscribes
 * and the dead path stays `Object.is`-stable. Inline `[]`/`{}`/`emptySelection`
 * would mint a new identity per render and churn subscriptions.
 */
const EMPTY_ORDER: readonly string[] = Object.freeze([]);
const FALLBACK_HEADLINE: { title: string; count: number } = Object.freeze({
  title: "Thread",
  count: 0,
});
const noUndefined: Selection<undefined> = emptySelection(undefined);
const noHeadline: Selection<{ title: string; count: number }> = emptySelection(FALLBACK_HEADLINE);

function InboxRow({
  id,
  store,
  machineId,
  now,
  open,
}: {
  id: string;
  store: SidebarSource;
  machineId: string;
  now: number;
  open(id: string): void;
}) {
  const theme = useTheme();
  const selection = useMemo(() => {
    try {
      return store.select([`thread:${id}`, "unconfirmed", "sync"], () => {
        const entry = store.thread(id);
        return entry
          ? { key: `${machineId}:${id}`, machineId, entry, unconfirmed: store.unconfirmed }
          : undefined;
      });
    } catch {
      return null;
    }
  }, [store, id, machineId]);
  const row = useFailClosedSelection(selection ?? noUndefined, undefined);
  if (!row) return null;
  const status = displayAppearance(inboxStatus(row, now), theme);
  return (
    <Pressable
      onPress={() => open(id)}
      accessibilityRole="button"
      accessibilityLabel={row.entry.title}
      style={{
        paddingHorizontal: tokens.spacing.xl,
        paddingVertical: tokens.spacing.md,
        borderBottomWidth: tokens.dimensions.border,
        borderBottomColor: theme.colours.separator,
      }}
    >
      <Text style={{ ...textStyle("rowTitle"), color: theme.colours.foreground }} numberOfLines={1}>
        {row.entry.title}
      </Text>
      <Text style={{ ...textStyle("caption"), color: status.textColour }}>{status.label}</Text>
    </Pressable>
  );
}

function ThreadItems({ store }: { store: ThreadSource }) {
  const theme = useTheme();
  const orderSelection = useMemo(() => {
    try {
      return store.select(["order"], (r) => r.order);
    } catch {
      return null;
    }
  }, [store]);
  const order = useFailClosedSelection(orderSelection ?? noOrder, EMPTY_ORDER);
  const window = useMemo(() => threadWindowFor(order, PRODUCTION_THREAD_WINDOW), [order]);
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
        data={window.shown}
        keyExtractor={(itemId: string) => itemId}
        renderItem={({ item }: { item: string }) => <ThreadItemRow id={item} store={store} />}
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

function ThreadItemRow({ id, store }: { id: string; store: ThreadSource }) {
  const theme = useTheme();
  const selection = useMemo(() => {
    try {
      return store.select([`item:${id}`], (r) => r.item(id));
    } catch {
      return null;
    }
  }, [store, id]);
  const item = useFailClosedSelection(selection ?? noUndefined, undefined);
  if (!item) return null;
  const { text, detail, user } = transcriptRowContent(item);
  if (!text && !detail) return null;
  return (
    <View
      style={{
        marginHorizontal: tokens.spacing.lg,
        marginVertical: tokens.spacing.xs,
        alignSelf: user ? "flex-end" : "stretch",
        maxWidth: user ? "85%" : "100%",
        backgroundColor: theme.colours.secondaryBackground,
        borderRadius: tokens.radii.bubble,
        padding: tokens.spacing.md,
      }}
    >
      <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>{text}</Text>
      {detail ? (
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          {detail}
        </Text>
      ) : null}
    </View>
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
  // never reach here (gated above); disconnect/removal still needs Retry.
  // Bounded: a persistently dead lease stops after the budget and waits for
  // manual Retry instead of churning leases every tick.
  useEffect(() => {
    if (!dead || routeBlocked) return;
    if (!shouldAutoRecoverReads(true, null, autoRecoveries)) return;
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
        <AceButton label="Back" onPress={onBack} kind="secondary" />
        <Text
          style={{ ...textStyle("rowTitle"), color: theme.colours.foreground, flex: 1 }}
          numberOfLines={1}
        >
          {headline?.title ?? "Thread"}
        </Text>
      </View>
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
        <View>
          <ThreadItems store={lease.store} />
        </View>
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
    </View>
  );
}

export function ActiveMachineInbox({
  startup,
  hostId,
  drafts,
  notify,
}: {
  startup: ProductionStartup;
  hostId: string;
  drafts: ThreadDraftStore | null;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const [openId, setOpenId] = useState<string | null>(null);
  // Synchronous host-switch reset: the old effect ran after paint and flashed
  // the previous machine's thread under the new host for one commit.
  // Resolving during render never paints the wrong owner's thread.
  const [prevHostId, setPrevHostId] = useState(hostId);
  if (prevHostId !== hostId) {
    setPrevHostId(hostId);
    setOpenId(null);
  }
  const effectiveOpenId = resolveOpenIdForHost(prevHostId, hostId, openId);
  const liveness = useLivenessTick();
  const [retryTick, setRetryTick] = useState(0);
  const [autoRecoveries, setAutoRecoveries] = useState(0);
  const route = startup.route(hostId);
  // `startup.route()` mints a fresh object per read, so effects and memos
  // below depend on the stable string key and the paired boolean — never the
  // route object itself, which would re-fire every render into a retry loop.
  const routeKey = routeKeyFor(route);
  const inboxVisible = shouldShowInbox(route);
  // A revoked/pin route must not keep the cached thread mounted: clear the
  // open id during render (same derived-state pattern as the host switch)
  // so the next branch below can never paint a stale thread.
  if (!inboxVisible && openId !== null) {
    setOpenId(null);
  }
  const gatedOpenId = openIdForRoute(effectiveOpenId, route);
  const canOperate = startup.canOperate(hostId);
  const now = useNowTick(gatedOpenId === null);

  const resolved = useMemo(() => {
    if (!inboxVisible) return { lease: null, problem: null as string | null };
    try {
      return { lease: startup.runtimeForReading(hostId).threads(), problem: null as string | null };
    } catch (error) {
      return { lease: null, problem: readingFailureCopy(error) };
    }
    // Route identity re-resolves (and releases) the lease; the liveness tick
    // only re-renders so the route flip above is noticed. Retry re-resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, routeKey, retryTick, inboxVisible]);
  const lease = resolved.lease;
  const problem = resolved.problem;
  // Keyed on the lease object: a route flip or retry mints a new lease and
  // the cleanup releases the stale one, so a revoked host never keeps its
  // old subscription alive.
  useEffect(() => () => lease?.release(), [lease]);

  const connectionSelection = useMemo(() => {
    if (!inboxVisible) return null;
    try {
      return startup.runtimeForReading(hostId).connectionState();
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, routeKey, retryTick, inboxVisible]);
  const connection = useFailClosedSelection(connectionSelection ?? noConnection, "connecting");

  const entriesSelection = useMemo(() => {
    if (lease === null) return null;
    try {
      // The retained lease invalidates its store on disconnect, replacement
      // or release: `select` then throws instead of handing out a stale
      // snapshot, so resolve to no selection and show "not connected" below
      // rather than crashing the render.
      return lease.store.select(["threads", "ids", "unconfirmed", "sync"], (s) =>
        inboxEntriesFor(s, hostId, now),
      );
    } catch {
      return null;
    }
    // Regroup on the phone clock like the fixture inbox; data regroups through tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lease, hostId, now]);
  const data: ProductionInboxEntry[] | undefined = useFailClosedSelection(
    entriesSelection ?? noEntries,
    undefined,
  );
  const invalidated =
    lease !== null && (entriesSelection === null || isDeadSelection(entriesSelection));
  const leaseDead = lease === null || invalidated;
  // Auto-recovery where safe: when fail-closed but a fresh read handle
  // already reports `ready`, re-resolve. Revoked routes never reach here;
  // disconnect/removal still needs Retry. Bounded: a persistently dead lease
  // stops after the budget and waits for manual Retry.
  useEffect(() => {
    if (!leaseDead || !inboxVisible) return;
    if (!shouldAutoRecoverReads(true, null, autoRecoveries)) return;
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
    // Deps keep the stable `routeKey`/`inboxVisible`, never the fresh-per-read
    // route object, so this fires on the 2s tick — not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, inboxVisible, routeKey, liveness, retryTick, leaseDead, autoRecoveries]);
  useEffect(() => {
    if (!leaseDead) setAutoRecoveries(0);
  }, [leaseDead]);
  function retry(): void {
    retryReading(startup, hostId);
    setAutoRecoveries(0);
    setRetryTick((value) => value + 1);
  }

  if (!inboxVisible) {
    return (
      <View style={{ paddingHorizontal: tokens.spacing.xl, gap: tokens.spacing.sm }}>
        <AceText role="caption">{route.route === "paired" ? null : route.message}</AceText>
      </View>
    );
  }

  if (gatedOpenId !== null) {
    return (
      <ProductionThreadView
        key={`${hostId}:${gatedOpenId}`}
        startup={startup}
        hostId={hostId}
        threadId={gatedOpenId}
        drafts={drafts}
        notify={notify}
        onBack={() => setOpenId(null)}
      />
    );
  }
  if (lease === null || invalidated) {
    return (
      <View style={{ paddingHorizontal: tokens.spacing.xl, gap: tokens.spacing.md }}>
        <AceText role="caption">
          {invalidated
            ? "This machine is not connected."
            : (problem ?? "This machine is not connected.")}
        </AceText>
        <AceButton label="Retry" onPress={retry} kind="secondary" />
      </View>
    );
  }
  const entries = data ?? [];
  return (
    <View
      style={{
        minHeight: INBOX_LIST_MIN_HEIGHT,
        maxHeight: INBOX_LIST_MAX_HEIGHT,
        flexShrink: 0,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: tokens.spacing.md,
          paddingHorizontal: tokens.spacing.xl,
          paddingVertical: tokens.spacing.sm,
        }}
      >
        <AceText role="rowTitle">Threads</AceText>
        {canOperate ? null : (
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            View only
          </Text>
        )}
        {connection && connection !== "ready" ? (
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            {connection}…
          </Text>
        ) : null}
        {connection !== "ready" ? (
          <AceButton label="Retry" onPress={retry} kind="secondary" />
        ) : null}
      </View>
      <FlashList
        data={entries}
        keyExtractor={(entry) => (entry.kind === "heading" ? entry.id : entry.key)}
        getItemType={(entry) => entry.kind}
        // Same ownership as the thread list: this bounded window scrolls
        // internally, the Machines screen scrolls the page. `flex:1` fills
        // the measured window; `nestedScrollEnabled` contains the gesture on
        // Android. FlashList v2 has no estimatedItemSize prop.
        style={{ flex: 1 }}
        nestedScrollEnabled
        renderItem={({ item: entry }) =>
          entry.kind === "heading" ? (
            <View
              style={{
                paddingHorizontal: tokens.spacing.xl,
                paddingTop: tokens.spacing.lg,
                paddingBottom: tokens.spacing.xs,
              }}
            >
              <Text style={{ ...textStyle("label"), color: theme.colours.mutedForeground }}>
                {entry.title}
              </Text>
            </View>
          ) : (
            <InboxRow
              id={entry.id}
              store={lease.store}
              machineId={hostId}
              now={now}
              open={setOpenId}
            />
          )
        }
        ListEmptyComponent={
          <Text
            style={{
              ...textStyle("body"),
              color: theme.colours.mutedForeground,
              paddingHorizontal: tokens.spacing.xl,
            }}
          >
            {connection === "ready" ? "No threads yet." : "Connecting to your machine…"}
          </Text>
        }
      />
    </View>
  );
}
