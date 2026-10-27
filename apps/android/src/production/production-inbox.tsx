import { useEffect, useMemo, useState } from "react";
import { Pressable, View, Text } from "react-native";
import type { ConnectionState, Selection, SidebarSource, ThreadSource } from "@ace/client";
import { transcriptRowContent } from "@ace/ui-core/mobile";
import { inboxStatus } from "@ace/ui-core/mobile";
import { useSelection } from "../selection.ts";
import { AceText, AceButton } from "../components.tsx";
import { tokens, useTheme, textStyle } from "../theme.tsx";
import { displayAppearance } from "../status.ts";
import {
  inboxEntriesFor,
  readingFailureCopy,
  shouldShowInbox,
  threadHeadlineFor,
  type ProductionInboxEntry,
} from "./production-inbox.ts";
import type { ProductionStartup } from "../runtime/production-startup.ts";

/**
 * Production inbox for the active machine, read-only.
 *
 * Mirrors the iOS inbox read path (rows stay readable while view-only) over
 * the reviewed `runtimeForReading` handle: only selection leases, the
 * connection selection and cached snapshots escape, never the raw SDK
 * `Client` and never a mutating or network-fetching call. Every lease is
 * released when the view unmounts or the host changes; a cached handle that
 * fails its exact-owner pin surfaces "not connected" instead of following
 * a new owner. No admit path lives here: mutations stay behind
 * `runtimeForMutation`, which this viewer never resolves.
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
  const row = useSelection(selection ?? emptySelection(undefined));
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
  const order = useSelection(orderSelection ?? noOrder);
  const shown = order.slice(-50);
  if (shown.length === 0) {
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
    <View>
      {shown.map((itemId) => (
        <ThreadItemRow key={itemId} id={itemId} store={store} />
      ))}
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
  const item = useSelection(selection ?? emptySelection(undefined));
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
  onBack,
}: {
  startup: ProductionStartup;
  hostId: string;
  threadId: string;
  onBack(): void;
}) {
  const theme = useTheme();
  const resolvedLease = useMemo(() => {
    try {
      return {
        lease: startup.runtimeForReading(hostId).thread(threadId),
        problem: null as string | null,
      };
    } catch (error) {
      return { lease: null, problem: readingFailureCopy(error) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId, threadId]);
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
  const headline = useSelection(headlineSelection ?? emptySelection({ title: "Thread", count: 0 }));
  const statusSelection = useMemo(() => {
    if (lease === null) return null;
    try {
      return lease.store.select(["thread"], (r) => r.thread?.status);
    } catch {
      return null;
    }
  }, [lease]);
  const statusValue = useSelection(statusSelection ?? emptySelection(undefined));
  if (lease === null || headlineSelection === null) {
    return (
      <View style={{ flex: 1, padding: tokens.spacing.xl, gap: tokens.spacing.md }}>
        <AceButton label="Back" onPress={onBack} kind="secondary" />
        <AceText role="body">{problem ?? "This machine is not connected."}</AceText>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
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
      <ThreadItems store={lease.store} />
      <View style={{ padding: tokens.spacing.lg }}>
        <AceText role="caption" colour={theme.colours.mutedForeground}>
          View only. Reply on your computer.
        </AceText>
      </View>
    </View>
  );
}

export function ActiveMachineInbox({
  startup,
  hostId,
}: {
  startup: ProductionStartup;
  hostId: string;
}) {
  const theme = useTheme();
  const [openId, setOpenId] = useState<string | null>(null);
  const route = startup.route(hostId);
  const canOperate = startup.canOperate(hostId);
  const now = useNowTick(openId === null);

  const resolved = useMemo(() => {
    if (!shouldShowInbox(route)) return { lease: null, problem: null as string | null };
    try {
      return { lease: startup.runtimeForReading(hostId).threads(), problem: null as string | null };
    } catch (error) {
      return { lease: null, problem: readingFailureCopy(error) };
    }
    // Route identity is data, not a hook dep: hostId switches re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId]);
  const lease = resolved.lease;
  const problem = resolved.problem;
  useEffect(() => () => lease?.release(), [lease]);
  // Switching machines closes the open thread: a thread id from the old
  // owner must never render under the new owner's lease.
  useEffect(() => setOpenId(null), [hostId]);

  const connectionSelection = useMemo(() => {
    if (!shouldShowInbox(route)) return null;
    try {
      return startup.runtimeForReading(hostId).connectionState();
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup, hostId]);
  const connection = useSelection(connectionSelection ?? noConnection);

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
  const data: ProductionInboxEntry[] | undefined = useSelection(entriesSelection ?? noEntries);
  const invalidated = lease !== null && entriesSelection === null;

  if (openId !== null) {
    return (
      <ProductionThreadView
        startup={startup}
        hostId={hostId}
        threadId={openId}
        onBack={() => setOpenId(null)}
      />
    );
  }

  if (!shouldShowInbox(route)) {
    return (
      <View style={{ paddingHorizontal: tokens.spacing.xl, gap: tokens.spacing.sm }}>
        <AceText role="caption">{route.route === "paired" ? null : route.message}</AceText>
      </View>
    );
  }
  if (lease === null || invalidated) {
    return (
      <View style={{ paddingHorizontal: tokens.spacing.xl }}>
        <AceText role="caption">
          {invalidated
            ? "This machine is not connected."
            : (problem ?? "This machine is not connected.")}
        </AceText>
      </View>
    );
  }
  const threads = (data ?? []).filter((e) => e.kind === "thread");
  return (
    <View style={{ gap: tokens.spacing.xs }}>
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
      </View>
      {threads.length === 0 ? (
        <Text
          style={{
            ...textStyle("body"),
            color: theme.colours.mutedForeground,
            paddingHorizontal: tokens.spacing.xl,
          }}
        >
          {connection === "ready" ? "No threads yet." : "Connecting to your machine…"}
        </Text>
      ) : (
        threads.map((entry) =>
          entry.kind === "thread" ? (
            <InboxRow
              key={entry.key}
              id={entry.id}
              store={lease.store}
              machineId={hostId}
              now={now}
              open={setOpenId}
            />
          ) : null,
        )
      )}
    </View>
  );
}
