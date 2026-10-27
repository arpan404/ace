import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import type { MachineEntry } from "@ace/client/machines";
import { inboxSections, inboxStatus, type InboxThread } from "@ace/ui-core/mobile";
import { AceButton, AceText } from "../components.tsx";
import { textStyle, tokens, useTheme } from "../theme.tsx";
import { displayAppearance } from "../status.ts";
import {
  INBOX_LIST_MAX_HEIGHT,
  INBOX_LIST_MIN_HEIGHT,
  inboxThreadsFor,
  readingFailureCopy,
  retryReading,
  routeKeyFor,
  shouldAutoRecoverReads,
  shouldPollAutoRecover,
  shouldShowInbox,
} from "./production-inbox.ts";
import {
  machineLabelFor,
  mergedEntriesFor,
  mergeInboxSections,
  mergedThreadsByKey,
  nextMergedReaderBudget,
  openKeyForRoutes,
  openKeyString,
  pairedHostsFor,
  pairedKeyFor,
  resolveOpenKeyForHosts,
  showsMachineNames,
  type MergedReaderBudget,
  type ProductionMergedEntry,
  type ProductionOpenKey,
} from "./production-merged-inbox.ts";
import type { ThreadDraftStore } from "../thread-drafts.ts";
import type { ProductionStartup } from "../runtime/production-startup.ts";
import {
  emptySelection,
  isDeadSelection,
  useFailClosedSelection,
  useLivenessTick,
  useNowTick,
} from "./production-inbox-common.tsx";
import { ProductionThreadView } from "./production-thread-view.tsx";
import {
  availableInboxActions,
  type InboxActionKind,
  type SnoozePresetId,
} from "../inbox-actions.ts";
import { currentProductionInboxGrant } from "./production-inbox-actions.ts";
import {
  operableScopedInboxActionUi,
  pruneInboxActionUiToHosts,
} from "./production-inbox-actions-store.ts";
import {
  ProductionInboxActionBanner,
  ProductionInboxRowActions,
  useProductionInboxActions,
} from "./production-inbox-actions-ui.tsx";

/**
 * One machine's live rows for the merged inbox. Resolves only that machine's
 * read-only lease (route-gated, exact-owner pinned, released with this
 * reader), reports its projected rows up, renders nothing. A dead lease
 * reports no rows, so one machine's trouble never touches another's.
 *
 * Reads only: row organization resolves `runtimeForMutation(hostId)` per tap
 * in the row view, never here and never the raw client.
 */
const noInboxThreads = emptySelection<InboxThread[] | undefined>(undefined);

interface MachineThreadsReport {
  threads: InboxThread[];
  dead: boolean;
  problem: string | null;
}

function MachineThreadsReader({
  startup,
  hostId,
  retryTick,
  onChange,
}: {
  startup: ProductionStartup;
  hostId: string;
  retryTick: number;
  onChange(hostId: string, report: MachineThreadsReport): void;
}) {
  const liveness = useLivenessTick();
  const [budget, setBudget] = useState<MergedReaderBudget>(() => ({
    autoRecoveries: 0,
    autoTick: 0,
    epoch: retryTick,
  }));
  const autoRecoveries = budget.autoRecoveries;
  const autoTick = budget.autoTick;
  const route = startup.route(hostId);
  const routeKey = routeKeyFor(route);
  const visible = shouldShowInbox(route);
  const resolved = useMemo(() => {
    if (!visible) return { lease: null, problem: null as string | null };
    try {
      return { lease: startup.runtimeForReading(hostId).threads(), problem: null as string | null };
    } catch (error) {
      return { lease: null, problem: readingFailureCopy(error) };
    }
    // Route identity re-resolves (and releases) the lease; the liveness tick
    // only re-renders so the route flip above is noticed. Retry re-resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, routeKey, retryTick, autoTick, visible]);
  const lease = resolved.lease;
  const problem = resolved.problem;
  useEffect(() => () => lease?.release(), [lease]);
  const threadsSelection = useMemo(() => {
    if (lease === null) return null;
    try {
      // A revoked pin throws instead of handing out a stale snapshot, so
      // resolve to no selection and report this machine dead below.
      return lease.store.select(["threads", "ids", "unconfirmed", "sync"], (s) =>
        inboxThreadsFor(s, hostId),
      );
    } catch {
      return null;
    }
  }, [lease, hostId]);
  const data = useFailClosedSelection(threadsSelection ?? noInboxThreads, undefined);
  const dead = lease === null || threadsSelection === null || isDeadSelection(threadsSelection);
  // Auto-recovery where safe: when this machine is fail-closed but a fresh
  // read handle already reports `ready`, re-resolve this machine's lease.
  // Revoked routes never reach here (the reader unmounts); a transient blip
  // recovers without Retry. Bounded like the single-machine inbox.
  useEffect(() => {
    if (!dead || !visible) return;
    if (!shouldPollAutoRecover(autoRecoveries)) return;
    let fresh: string | null = null;
    try {
      fresh = startup.runtimeForReading(hostId).connectionState().getSnapshot();
    } catch {
      return;
    }
    if (shouldAutoRecoverReads(true, fresh, autoRecoveries)) {
      setBudget((prev) => ({
        ...prev,
        autoRecoveries: prev.autoRecoveries + 1,
        autoTick: prev.autoTick + 1,
      }));
    }
    // Poll on the liveness tick so a transient blip recovers without Retry.
    // Deps keep the stable `routeKey`/`visible`, never the fresh-per-read
    // route object, so this fires on the 2s tick — not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, dead, visible, routeKey, liveness, retryTick, autoTick, autoRecoveries]);
  // Budget follows the parent Retry tick: a tick past the absorbed epoch
  // resets the bound (same guarantee as the single-machine Retry), and a
  // healthy read resets without any Retry. See `nextMergedReaderBudget`.
  useEffect(() => {
    setBudget((prev) => nextMergedReaderBudget(prev, retryTick, dead));
  }, [retryTick, dead]);
  useEffect(() => {
    onChange(hostId, { threads: data ?? [], dead, problem });
  }, [hostId, data, dead, problem, onChange]);
  return null;
}

/** One merged row, read from the reported frozen copy: no subscription. */
function MergedInboxRowView({
  row,
  now,
  machineName,
  open,
  canAct,
  busy,
  onAct,
}: {
  row: InboxThread;
  now: number;
  machineName: string | null;
  open(key: ProductionOpenKey): void;
  canAct: boolean;
  busy: boolean;
  onAct(kind: InboxActionKind, preset?: SnoozePresetId): void;
}) {
  const theme = useTheme();
  const status = displayAppearance(inboxStatus(row, now), theme);
  const offered = availableInboxActions(row.entry, now, canAct);
  return (
    <Pressable
      onPress={() => open({ machineId: row.machineId, id: row.entry.id })}
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

/**
 * The production inbox across every paired machine, merged by rank.
 *
 * Mirrors the iOS `MachineInbox.merged` read path over the reviewed
 * per-machine `runtimeForReading` handles: each paired host keeps its own
 * lease (resolved and released per host, route-gated, exact-owner pinned),
 * rows merge by the shared grouping/ranking rules, and a row opens its own
 * machine's thread. One host's revocation or disconnect drops only its rows;
 * the open thread closes only when its own host leaves `paired`. Rows stay
 * readable while view-only; organization goes through the per-host mutation
 * gate per tap (`production-inbox-actions.ts`), never a cached handle.
 */
export function MergedMachineInbox({
  startup,
  entries,
  drafts,
  notify,
}: {
  startup: ProductionStartup;
  entries: readonly MachineEntry[];
  drafts: ThreadDraftStore | null;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const [openKey, setOpenKey] = useState<ProductionOpenKey | null>(null);
  const [reports, setReports] = useState<Record<string, MachineThreadsReport>>({});
  const [retryTicks, setRetryTicks] = useState<Record<string, number>>({});
  const routeOf = (hostId: string) => startup.route(hostId);
  // `startup.route()` mints a fresh object per read, so only the host list
  // and the liveness tick below re-derive pairing — never the route objects.
  const paired = pairedHostsFor(
    entries.map((entry) => entry.hostId),
    routeOf,
  );
  const pairedKey = pairedKeyFor(paired);
  const names = useMemo(
    () => Object.fromEntries(entries.map((entry) => [entry.hostId, entry.displayName])),
    [entries],
  );
  const gatedOpenKey = openKeyForRoutes(resolveOpenKeyForHosts(openKey, paired), routeOf);
  // A revoked route or a removed machine must not keep its thread mounted:
  // clear during render (same derived-state pattern as the host switch) so
  // the branch below can never paint a stale machine's thread.
  if (openKey !== null && gatedOpenKey === null) {
    setOpenKey(null);
  }
  const onChange = useCallback((hostId: string, report: MachineThreadsReport) => {
    setReports((prev) => {
      const current = prev[hostId];
      if (
        current !== undefined &&
        current.dead === report.dead &&
        current.problem === report.problem &&
        current.threads === report.threads
      )
        return prev;
      return { ...prev, [hostId]: report };
    });
  }, []);
  // Drop reports for hosts that left `paired` (revoked, removed): their rows
  // vanish with their lease instead of lingering as stale state. The shared
  // inbox-action store prunes alongside: a departed host's Undo/failures,
  // busy keys and receipt listeners never survive into the next session,
  // while live hosts keep theirs through transient offline.
  useEffect(() => {
    setReports((prev) => {
      const next: Record<string, MachineThreadsReport> = {};
      let changed = false;
      for (const [hostId, report] of Object.entries(prev)) {
        if (paired.includes(hostId)) next[hostId] = report;
        else changed = true;
      }
      return changed ? next : prev;
    });
    pruneInboxActionUiToHosts(paired);
    // `paired` is re-derived per render; the stable key avoids effect churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairedKey]);
  const now = useNowTick(gatedOpenKey === null);
  const merged = useMemo(
    () =>
      mergeInboxSections(
        paired.map((hostId) => ({
          machineId: hostId,
          sections: inboxSections(reports[hostId]?.threads ?? [], [], now),
        })),
      ),
    // Grouping re-runs on the phone clock like the single-machine inbox.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pairedKey, reports, now],
  );
  const data: ProductionMergedEntry[] = useMemo(() => mergedEntriesFor(merged), [merged]);
  const showNames = showsMachineNames(paired.length);
  const canOperateFor = (hostId: string): boolean =>
    currentProductionInboxGrant((host) => startup.canOperate(host), hostId);
  // Fail-closed grant read per host through the shared helper; re-read every
  // render so the liveness tick below bounds stale buttons after revocation.
  const allViewOnly = paired.length > 0 && paired.every((hostId) => !canOperateFor(hostId));
  const inboxActions = useProductionInboxActions(startup, {
    hostLabel: showNames ? (hostId) => machineLabelFor(hostId, names) : undefined,
  });
  // Shared store, per-host display: only paired hosts' operable offers render
  // here. A revoked host keeps its stored offers and listeners; they hide
  // until the grant returns instead of being destroyed.
  const scoped = operableScopedInboxActionUi(paired, (host) => startup.canOperate(host));
  const visibleUndo = scoped.undo ?? null;
  const visibleFailed = scoped.failed ?? null;
  function retry(hostId: string): void {
    retryReading(startup, hostId);
    setRetryTicks((prev) => ({ ...prev, [hostId]: (prev[hostId] ?? 0) + 1 }));
  }
  // The liveness tick re-renders so route flips (revocation) and clock
  // regroups surface; lease re-resolution keys on route identity and retry
  // ticks, never on this tick, so no lease churn.
  useLivenessTick();

  if (gatedOpenKey !== null) {
    return (
      <ProductionThreadView
        key={openKeyString(gatedOpenKey)}
        startup={startup}
        hostId={gatedOpenKey.machineId}
        threadId={gatedOpenKey.id}
        drafts={drafts}
        notify={notify}
        onBack={() => setOpenKey(null)}
      />
    );
  }
  const deadHosts = paired.filter((hostId) => reports[hostId]?.dead !== false);
  const byKey = mergedThreadsByKey(reports, merged);
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
        {allViewOnly ? (
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            View only
          </Text>
        ) : null}
      </View>
      {paired.map((hostId) =>
        reports[hostId]?.dead === true ? (
          <View
            key={`dead:${hostId}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: tokens.spacing.md,
              paddingHorizontal: tokens.spacing.xl,
              paddingVertical: tokens.spacing.xs,
            }}
          >
            <AceText role="caption">
              {machineLabelFor(hostId, names)}:{" "}
              {reports[hostId]?.problem ?? "This machine is not connected."}
            </AceText>
            <AceButton label="Retry" onPress={() => retry(hostId)} kind="secondary" />
          </View>
        ) : null,
      )}
      <FlashList
        data={data}
        keyExtractor={(entry) => (entry.kind === "heading" ? entry.id : entry.key)}
        getItemType={(entry) => entry.kind}
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
            (() => {
              const row = byKey.get(entry.key);
              if (row === undefined) return null;
              return (
                <MergedInboxRowView
                  row={row}
                  now={now}
                  machineName={showNames ? machineLabelFor(entry.machineId, names) : null}
                  open={setOpenKey}
                  canAct={canOperateFor(row.machineId)}
                  busy={inboxActions.isBusy(row.machineId, row.entry.id)}
                  onAct={(kind, preset) => {
                    void inboxActions
                      .act(row.machineId, kind, row.entry.id, preset)
                      .then((issue) => {
                        if (issue) notify(issue);
                      });
                  }}
                />
              );
            })()
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
            {deadHosts.length > 0 ? "Connecting to your machines…" : "No threads yet."}
          </Text>
        }
      />
      {paired.map((hostId) => (
        <MachineThreadsReader
          key={hostId}
          startup={startup}
          hostId={hostId}
          retryTick={retryTicks[hostId] ?? 0}
          onChange={onChange}
        />
      ))}
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
