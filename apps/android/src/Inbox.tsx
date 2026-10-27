import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { View, Text, Pressable } from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import type { ClientApi, SidebarSource } from "@ace/client";
import { useSelection } from "./selection.ts";
import { AceHost, tokens, useTheme, textStyle } from "./theme.tsx";
import {
  AceText,
  AceButton,
  Column,
  Row,
  StatusPill,
  padding,
  fillMaxWidth,
  background,
} from "./components.tsx";
import { AceSheet } from "./sheets.tsx";
import { clickable } from "@expo/ui/jetpack-compose/modifiers";
import { inboxSections, inboxStatus, inboxNextChange, type InboxThread } from "@ace/ui-core/mobile";
import {
  availableInboxActions,
  canActInbox,
  runInboxAction,
  snoozeOptions,
  undoActionFor,
  watchInboxReceipt,
  type InboxActionKind,
  type SnoozePresetId,
} from "./inbox-actions.ts";
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
  actions,
  canAct,
}: {
  id: string;
  store: SidebarSource;
  open(id: string): void;
  now(): number;
  actions(id: string): void;
  canAct: boolean;
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
            <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: tokens.spacing.xs }}>
              <StatusPill {...status} />
              {canAct ? (
                <AceButton label="···" kind="secondary" onPress={() => actions(id)} />
              ) : null}
            </Row>
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
interface UndoOffer {
  threadId: string;
  undo: "unarchive" | "unsettle";
  label: string;
}
interface FailedAction {
  kind: InboxActionKind;
  threadId: string;
  preset?: SnoozePresetId | undefined;
  message: string;
}

/** One row's organization commands, with the same availability as the iOS row's menu. */
function InboxActionsSheet({
  store,
  id,
  now,
  canAct,
  dismiss,
  act,
}: {
  store: SidebarSource;
  id: string;
  now(): number;
  canAct: boolean;
  dismiss(): void;
  act(kind: InboxActionKind, threadId: string, preset?: SnoozePresetId): Promise<string | null>;
}) {
  const theme = useTheme();
  const [snoozing, setSnoozing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = useSelection(
    useMemo(() => store.select([`thread:${id}`], (r) => r.thread(id)), [store, id]),
  );
  const offered = useMemo(
    () => (entry ? availableInboxActions(entry, now(), canAct) : null),
    // now() is the phone's clock, read once per entry change; regrouping re-renders anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entry, canAct],
  );
  if (!entry || !offered) return null;
  async function run(kind: InboxActionKind, preset?: SnoozePresetId) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const problem = await act(kind, id, preset);
      if (problem === null) dismiss();
      else setError(problem);
    } finally {
      setBusy(false);
    }
  }
  if (!canAct)
    return (
      <AceSheet title={entry.title} dismiss={dismiss}>
        <AceText role="caption" colour={theme.colours.mutedForeground}>
          This phone can only view this machine. Pair it with View and act to organize threads.
        </AceText>
      </AceSheet>
    );
  return (
    <AceSheet title={entry.title} dismiss={dismiss}>
      <Column verticalArrangement={{ spacedBy: tokens.spacing.sm }}>
        {offered.settle ? (
          <AceButton
            label="Settle"
            kind="secondary"
            enabled={!busy}
            onPress={() => void run("settle")}
          />
        ) : null}
        {offered.unsettle ? (
          <AceButton
            label="Unsettle"
            kind="secondary"
            enabled={!busy}
            onPress={() => void run("unsettle")}
          />
        ) : null}
        {offered.snooze && !snoozing ? (
          <AceButton
            label="Snooze"
            kind="secondary"
            enabled={!busy}
            onPress={() => setSnoozing(true)}
          />
        ) : null}
        {offered.snooze && snoozing
          ? snoozeOptions(now()).map((option) => (
              <AceButton
                key={option.id}
                label={`${option.label} · ${option.detail}`}
                kind="secondary"
                enabled={!busy}
                onPress={() => void run("snooze", option.id)}
              />
            ))
          : null}
        {offered.wake ? (
          <AceButton
            label="Wake"
            kind="secondary"
            enabled={!busy}
            onPress={() => void run("wake")}
          />
        ) : null}
        {offered.archive ? (
          <AceButton
            label="Archive"
            kind="secondary"
            enabled={!busy}
            onPress={() => void run("archive")}
          />
        ) : null}
        <AceText role="caption" colour={theme.colours.mutedForeground}>
          {busy ? "Saving on this device…" : "The row moves once your machine confirms it."}
        </AceText>
        {error ? (
          <AceText role="caption" colour={theme.statusText.failed}>
            {error}
          </AceText>
        ) : null}
      </Column>
    </AceSheet>
  );
}

/** The Undo toast after an admitted settle/archive, and the retry banner for failed actions. */
function InboxActionBanner({
  undo,
  failed,
  onUndo,
  onRetry,
  onDismissFailed,
}: {
  undo: UndoOffer | null;
  failed: FailedAction | null;
  onUndo(): void;
  onRetry(): void;
  onDismissFailed(): void;
}) {
  const theme = useTheme();
  if (!undo && !failed) return null;
  return (
    <View
      style={{
        position: "absolute",
        bottom: tokens.spacing.md,
        left: tokens.spacing.md,
        right: tokens.spacing.md,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: theme.colours.foreground,
        borderRadius: tokens.radii.pill,
        paddingLeft: tokens.spacing.xl,
        paddingRight: tokens.spacing.lg,
        paddingVertical: tokens.spacing.sm,
        minHeight: tokens.dimensions.touchTarget,
      }}
    >
      <Text
        style={{ ...textStyle("label"), color: theme.colours.background, flex: 1 }}
        numberOfLines={2}
      >
        {undo ? undo.label : (failed?.message ?? "The request failed.")}
      </Text>
      {undo ? (
        <Pressable
          onPress={onUndo}
          accessibilityRole="button"
          accessibilityLabel="Undo"
          style={{ padding: tokens.spacing.sm }}
        >
          <Text style={{ ...textStyle("label"), color: theme.colours.background }}>Undo</Text>
        </Pressable>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry"
            style={{ padding: tokens.spacing.sm }}
          >
            <Text style={{ ...textStyle("label"), color: theme.colours.background }}>Retry</Text>
          </Pressable>
          <Pressable
            onPress={onDismissFailed}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            style={{ padding: tokens.spacing.sm }}
          >
            <Text style={{ ...textStyle("label"), color: theme.colours.background }}>Dismiss</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** Native timers take 32-bit delays; a longer wait re-arms when it fires. */
const longestWait = 2 ** 31 - 1;

export function Inbox({
  client,
  open,
  machines,
  settings,
  now,
  notify,
  canAct,
  onSearch,
}: {
  client: ClientApi;
  open(id: string): void;
  machines(): void;
  settings(): void;
  now(): number;
  notify?(text: string): void;
  /**
   * Whether this phone may organize threads. Fail closed: anything but an
   * explicit `true` hides every action, matching iOS (`canOperate ?? false`).
   */
  canAct?: boolean | undefined;
  /** Opens conversation-content search. Omitted only where search is unavailable. */
  onSearch?(): void;
}) {
  const theme = useTheme();
  const operate = canActInbox(canAct);
  const lease = useMemo(() => client.threads(), [client]);
  useEffect(() => () => lease.release(), [lease]);
  // A snooze ends on this phone's clock even while its machine is offline: regroup then.
  const [tick, setTick] = useState(0);
  const selection = useMemo(
    () =>
      lease.store.select(
        ["threads", "ids", "unconfirmed", "sync"],
        () => entries(lease.store, now()),
        (a, b) => a.length === b.length && a.every((v, i) => v.id === b[i]?.id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lease, now, tick],
  );
  const data = useSelection(selection);
  useEffect(() => {
    const threads: InboxThread[] = [];
    for (const id of lease.store.ids) {
      const thread = inboxThread(lease.store, id);
      if (thread) threads.push(thread);
    }
    const at = inboxNextChange(threads, now());
    if (at === undefined) return;
    const timer = setTimeout(
      () => setTick((value) => value + 1),
      Math.min(longestWait, Math.max(0, at - now())),
    );
    return () => clearTimeout(timer);
    // data regroups through tick; depending on it here would re-arm the timer every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lease, now, tick]);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoOffer | null>(null);
  const [failed, setFailed] = useState<FailedAction | null>(null);
  // One receipt listener per admitted command, dropped at its terminal state; the map
  // only holds commands still waiting on the machine, and is trimmed for safety.
  const receipts = useRef(new Map<string, () => void>());
  useEffect(
    () => () => {
      for (const stop of receipts.current.values()) stop();
      receipts.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 5000);
    return () => clearTimeout(timer);
  }, [undo]);
  const list = useRef<FlashListRef<InboxEntry>>(null);
  const reveal = useCallback(
    (id: string) => {
      try {
        const index = data.findIndex((entry) => entry.kind === "thread" && entry.id === id);
        if (index >= 0) list.current?.scrollToIndex({ index, viewPosition: 0.5 });
      } catch {
        // The row regrouped before the scroll landed; the list already shows it.
      }
    },
    [data],
  );
  const showActions = useCallback((id: string) => setSheetFor(id), []);
  const dismissSheet = useCallback(() => setSheetFor(null), []);
  const dismissFailed = useCallback(() => setFailed(null), []);
  /**
   * Admit one inbox action. Returns the admission problem, if any, so the caller
   * shows it where the person still is: the sheet shows it inline (a retry banner
   * behind the open sheet would be hidden), while Undo/Retry surface it as the banner.
   */
  const act = useCallback(
    async (
      kind: InboxActionKind,
      threadId: string,
      preset?: SnoozePresetId,
    ): Promise<string | null> => {
      const outcome = await runInboxAction(client, kind, threadId, now(), preset, operate);
      if (!outcome.admitted) return outcome.error ?? "The request failed.";
      if (outcome.commandId) {
        const commandId = outcome.commandId;
        receipts.current.get(commandId)?.();
        receipts.current.delete(commandId);
        // Terminal states unsubscribe themselves; the trim only bounds commands
        // the machine never answers (e.g. a long offline stretch).
        while (receipts.current.size >= 20) {
          const oldest = receipts.current.keys().next();
          if (oldest.done) break;
          receipts.current.get(oldest.value)?.();
          receipts.current.delete(oldest.value);
        }
        receipts.current.set(
          commandId,
          watchInboxReceipt(client, commandId, (error) => {
            receipts.current.delete(commandId);
            // A refusal replaces the toast: the Undo offer is void once the
            // machine refuses the command it would take back.
            setUndo((current) => (current?.threadId === threadId ? null : current));
            setFailed({
              kind,
              threadId,
              preset,
              message:
                error !== undefined && error !== ""
                  ? `Your machine refused it (${error}).`
                  : "Your machine refused it.",
            });
          }),
        );
      }
      const undoKind = undoActionFor(kind);
      if (undoKind)
        setUndo({
          threadId,
          undo: undoKind,
          label: kind === "settle" ? "Settled thread" : "Archived thread",
        });
      else notify?.("Saved. The row moves once your machine confirms it.");
      return null;
    },
    [client, now, operate, notify],
  );
  const undoNow = useCallback(async () => {
    if (!undo) return;
    const current = undo;
    setUndo(null);
    const problem = await act(current.undo, current.threadId);
    if (problem !== null)
      setFailed({ kind: current.undo, threadId: current.threadId, message: problem });
    else reveal(current.threadId);
  }, [undo, act, reveal]);
  const retry = useCallback(async () => {
    if (!failed) return;
    const current = failed;
    setFailed(null);
    const problem = await act(current.kind, current.threadId, current.preset);
    if (problem !== null) setFailed({ ...current, message: problem });
  }, [failed, act]);
  const renderItem = useCallback(
    ({ item }: { item: InboxEntry }) =>
      item.kind === "thread" ? (
        <InboxRow
          id={item.id}
          store={lease.store}
          open={open}
          now={now}
          actions={showActions}
          canAct={operate}
        />
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
      ),
    [lease.store, open, now, showActions, operate, theme],
  );
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
        <Pressable
          onPress={settings}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          style={{ minHeight: tokens.dimensions.touchTarget, justifyContent: "center" }}
        >
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            Settings ›
          </Text>
        </Pressable>
        {onSearch ? (
          <Pressable
            onPress={onSearch}
            accessibilityRole="button"
            accessibilityLabel="Search conversations"
            style={{ minHeight: tokens.dimensions.touchTarget, justifyContent: "center" }}
          >
            <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
              Search ›
            </Text>
          </Pressable>
        ) : null}
        {operate ? null : (
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            View only
          </Text>
        )}
      </View>
      <FlashList
        ref={list}
        data={data}
        keyExtractor={(item) => item.id}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
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
      {sheetFor ? (
        <InboxActionsSheet
          store={lease.store}
          id={sheetFor}
          now={now}
          canAct={operate}
          dismiss={dismissSheet}
          act={act}
        />
      ) : null}
      <InboxActionBanner
        undo={undo}
        failed={failed}
        onUndo={() => void undoNow()}
        onRetry={() => void retry()}
        onDismissFailed={dismissFailed}
      />
    </View>
  );
}
