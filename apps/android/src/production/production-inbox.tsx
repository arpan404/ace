import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import type { SidebarSource } from "@ace/client";
import { inboxStatus } from "@ace/ui-core/mobile";
import { AceButton, AceText } from "../components.tsx";
import {
  availableInboxActions,
  type InboxActionKind,
  type SnoozePresetId,
} from "../inbox-actions.ts";
import {
  ProductionInboxActionBanner,
  ProductionInboxRowActions,
  useProductionInboxActions,
} from "./production-inbox-actions-ui.tsx";
import { textStyle, tokens, useTheme } from "../theme.tsx";
import { displayAppearance } from "../status.ts";
import {
  INBOX_LIST_MAX_HEIGHT,
  INBOX_LIST_MIN_HEIGHT,
  inboxEntriesFor,
  openIdForRoute,
  readingFailureCopy,
  resolveOpenIdForHost,
  retryReading,
  routeKeyFor,
  shouldAutoRecoverReads,
  shouldPollAutoRecover,
  shouldShowInbox,
  type ProductionInboxEntry,
} from "./production-inbox.ts";
import {
  canShowProductionInboxActions,
  currentProductionInboxGrant,
} from "./production-inbox-actions.ts";
import type { ThreadDraftStore } from "../thread-drafts.ts";
import type { ProductionStartup } from "../runtime/production-startup.ts";
import {
  isDeadSelection,
  noConnection,
  noEntries,
  noUndefined,
  useFailClosedSelection,
  useLivenessTick,
  useNowTick,
} from "./production-inbox-common.tsx";
import {
  invalidateInboxActionUiForHost,
  operableScopedInboxActionUi,
} from "./production-inbox-actions-store.ts";
import { ProductionThreadView } from "./production-thread-view.tsx";

/**
 * Production inbox for the active machine, readable while view-only.
 *
 * Mirrors the iOS inbox read path (rows stay readable while view-only) over
 * the reviewed `runtimeForReading` handle: only selection leases, the
 * connection selection and cached snapshots escape, never the raw SDK
 * `Client` and never a network-fetching call. Every lease is released when
 * the view unmounts, the host changes, or the route leaves `paired`; a cached
 * handle that fails its exact-owner pin surfaces "not connected" instead of
 * following a new owner. Organization (settle/archive/snooze/wake/undo) goes
 * through `runtimeForMutation(hostId)` per tap with a fresh grant re-check
 * (`production-inbox-actions.ts`); view-only phones keep the "View only"
 * label and no row buttons.
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

function InboxRow({
  id,
  store,
  machineId,
  now,
  open,
  machineName = null,
  canAct,
  busy,
  onAct,
}: {
  id: string;
  store: SidebarSource;
  machineId: string;
  now: number;
  open(id: string): void;
  machineName?: string | null;
  canAct: boolean;
  busy: boolean;
  onAct(kind: InboxActionKind, preset?: SnoozePresetId): void;
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
  const offered = availableInboxActions(row.entry, now, canAct);
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
      {machineName !== null ? (
        <Text
          style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}
          numberOfLines={1}
        >
          {machineName}
        </Text>
      ) : null}
      <Text style={{ ...textStyle("caption"), color: status.textColour }}>{status.label}</Text>
      {canAct ? (
        <ProductionInboxRowActions offered={offered} busy={busy} now={now} onAct={onAct} />
      ) : null}
    </Pressable>
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
  // Fail-closed grant read through the shared helper: unknown hosts and
  // throwing grants stay view-only. Re-read every render, so the 2s liveness
  // tick bounds stale buttons after revocation; the tap itself re-checks.
  const canOperate = currentProductionInboxGrant((host) => startup.canOperate(host), hostId);
  const showActions = canShowProductionInboxActions(canOperate);
  const now = useNowTick(gatedOpenId === null);
  const inboxActions = useProductionInboxActions(startup);
  // Session/host teardown for the single view: once the route leaves `paired`
  // (removed, revoked, pin mismatch) the host's Undo/failures/busy and
  // receipt listeners must not survive into the next session. Transient
  // offline keeps the route `paired`, so durable offers and receipts persist.
  useEffect(() => {
    if (!inboxVisible) invalidateInboxActionUiForHost(hostId);
  }, [hostId, inboxVisible]);
  // The module store is shared across hosts: only this host's operable offer
  // renders here, so switching to another machine never shows a stale
  // cross-host Undo. A revoked (view-only) grant hides the offer without
  // destroying it; anything hidden stays stored and resurfaces on switch-back
  // or re-grant.
  const scoped = operableScopedInboxActionUi([hostId], (host) => startup.canOperate(host));
  const visibleUndo = inboxVisible ? (scoped.undo ?? null) : null;
  const visibleFailed = inboxVisible ? (scoped.failed ?? null) : null;

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
  // a transient blip recovers without Retry. Bounded: a persistently dead
  // lease stops after the budget and waits for manual Retry.
  useEffect(() => {
    if (!leaseDead || !inboxVisible) return;
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
        position: "relative",
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
        {showActions ? null : (
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
              canAct={showActions}
              busy={inboxActions.isBusy(hostId, entry.id)}
              onAct={(kind, preset) => {
                void inboxActions.act(hostId, kind, entry.id, preset).then((issue) => {
                  if (issue) notify(issue);
                });
              }}
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
      <ProductionInboxActionBanner
        undo={visibleUndo}
        failed={visibleFailed}
        onUndo={() => void inboxActions.undoNow(visibleUndo)}
        onRetry={() => void inboxActions.retryFailed(visibleFailed)}
        onDismissFailed={() => inboxActions.dismissFailed(visibleFailed)}
      />
    </View>
  );
}

export { ProductionThreadView };
export { MergedMachineInbox } from "./production-merged-inbox-view.tsx";
