import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import type { ClientApi, SidebarSource } from "@ace/client";
import { inboxStatus, type InboxThread } from "@ace/ui-core/mobile";
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
import { clickable } from "@expo/ui/jetpack-compose/modifiers";
import {
  ArchivePaging,
  readArchiveList,
  archiveFooterKind,
  type ArchiveListState,
} from "./archive.ts";
import { canActInbox, runInboxAction, watchInboxReceipt } from "./inbox-actions.ts";
import { displayAppearance } from "./status.ts";

/*
 * Android archived-thread browser (parity slice A04.04): one machine's archived
 * threads, most recently archived first, 20 per page from the SDK's archive window,
 * mirroring iOS `ArchiveView`/`ArchiveRows`. A thread opens read-only; Unarchive
 * returns it to the inbox through the durable outbox. Unmounting returns the shared
 * store to the home window, so the inbox underneath regroups to live rows again.
 * Read-only grants stay read-only: no Unarchive button and nothing admitted.
 */

const machineId = "local";

function archiveThread(store: SidebarSource, id: string): InboxThread | undefined {
  const entry = store.thread(id);
  return entry && { key: id, machineId, entry, unconfirmed: store.unconfirmed };
}

function archiveRowState(
  store: SidebarSource,
  id: string,
): { row: InboxThread | undefined; syncing: boolean; errorCode: string | undefined } {
  return {
    row: archiveThread(store, id),
    syncing: store.syncing ?? false,
    errorCode: store.error?.code,
  };
}

function archiveEqual(a: ArchiveListState, b: ArchiveListState): boolean {
  return (
    a.open === b.open &&
    a.more === b.more &&
    a.loaded === b.loaded &&
    a.loading === b.loading &&
    a.failed === b.failed &&
    a.syncing === b.syncing &&
    a.errorCode === b.errorCode &&
    a.ids.length === b.ids.length &&
    a.ids.every((id, index) => id === b.ids[index])
  );
}

const ArchiveRow = memo(function ArchiveRow({
  id,
  store,
  open,
  now,
  operate,
  unarchive,
  busy,
}: {
  id: string;
  store: SidebarSource;
  open(id: string): void;
  now(): number;
  operate: boolean;
  unarchive(id: string): void;
  busy: boolean;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () =>
      store.select(
        [`thread:${id}`, "unconfirmed", "sync", "error"],
        () => archiveRowState(store, id),
        (a, b) =>
          a.row?.entry === b.row?.entry &&
          a.row?.unconfirmed === b.row?.unconfirmed &&
          a.syncing === b.syncing &&
          a.errorCode === b.errorCode,
      ),
    [store, id],
  );
  const state = useSelection(selection);
  const row = state.row;
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
            background(theme.colours.background),
            clickable(() => open(id)),
            padding(tokens.spacing.xl, tokens.spacing.md, tokens.spacing.xl, tokens.spacing.md),
          ]}
          verticalArrangement={{ spacedBy: tokens.spacing.xs }}
        >
          <Row modifiers={[fillMaxWidth()]} horizontalArrangement="spaceBetween">
            <AceText role="caption" colour={theme.colours.mutedForeground}>
              {thread.workspaceId}
            </AceText>
            <StatusPill {...status} />
          </Row>
          <AceText role="rowTitle" maxLines={1}>
            {thread.title}
          </AceText>
          <Row
            modifiers={[fillMaxWidth()]}
            horizontalArrangement="spaceBetween"
            verticalAlignment="center"
          >
            <AceText role="caption" colour={theme.colours.mutedForeground}>
              Opens read-only
            </AceText>
            {operate ? (
              <AceButton
                label="Unarchive"
                kind="secondary"
                enabled={!busy}
                onPress={() => unarchive(id)}
              />
            ) : null}
          </Row>
        </Column>
      </AceHost>
    </View>
  );
});

export function ArchiveScreen({
  client,
  open,
  now,
  notify,
  canAct,
}: {
  client: ClientApi;
  open(id: string): void;
  now(): number;
  notify?(text: string): void;
  /**
   * Whether this phone may unarchive. Fail closed: anything but an explicit
   * `true` hides Unarchive and admits nothing, matching iOS (`canOperate`).
   */
  canAct?: boolean | undefined;
}) {
  const theme = useTheme();
  const operate = canActInbox(canAct);
  const lease = useMemo(() => client.threads(), [client]);
  const paging = useMemo(() => new ArchivePaging(), []);
  // The pager's loading/failed flags live outside the store snapshot, so an
  // epoch re-reads the list whenever a window call settles.
  const [epoch, setEpoch] = useState(0);
  // One receipt listener per admitted unarchive, dropped at its terminal state.
  const receipts = useRef(new Map<string, () => void>());
  useEffect(() => {
    const pending = receipts.current;
    return () => {
      for (const stop of pending.values()) stop();
      pending.clear();
    };
  }, []);
  useEffect(() => {
    const pending = receipts.current;
    let active = true;
    void paging.openArchive(client).then((landed) => {
      if (active && landed) setEpoch((value) => value + 1);
    });
    return () => {
      active = false;
      // Repoint the shared store home before dropping this lease; the retry keeps
      // a single offline blip from stranding the inbox on the archive window, and
      // a failed restore is surfaced instead of leaving it there silently.
      void paging
        .closeArchiveWithRetry(client, 3)
        .then((restored) => {
          if (!restored) notify?.("Could not return home. Reopen the archive to retry.");
        })
        .finally(() => {
          for (const stop of pending.values()) stop();
          pending.clear();
          lease.release();
        });
    };
  }, [client, lease, paging, notify]);
  const selection = useMemo(
    () =>
      lease.store.select(
        ["threads", "ids", "window", "homeWindow", "error", "sync", "unconfirmed"],
        () => readArchiveList(lease.store, paging.loading, paging.failed),
        archiveEqual,
      ),
    // Epoch re-reads after each window call settles; the store taps drive the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lease, epoch],
  );
  const list = useSelection(selection);
  const connection = useSelection(useMemo(() => client.connectionState(), [client]));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const more = useCallback(async () => {
    if (!(await paging.loadMore(client, list.more))) {
      // A refused page (already loading, or nothing older) still re-reads:
      // the footer may have flipped while the tap was in flight.
    }
    setEpoch((value) => value + 1);
  }, [client, paging, list.more]);
  const retry = useCallback(async () => {
    // Deliberately more robust than the iOS footer (which only pages): when
    // the archive never loaded, the window itself failed, so reopen it.
    if (!list.loaded) await paging.openArchive(client);
    else await paging.loadMore(client, list.more);
    setEpoch((value) => value + 1);
  }, [client, paging, list.loaded, list.more]);
  const unarchive = useCallback(
    async (id: string) => {
      if (busyId !== null) return;
      setBusyId(id);
      setProblem(null);
      try {
        const outcome = await runInboxAction(client, "unarchive", id, now(), undefined, operate);
        if (!outcome.admitted) {
          setProblem(outcome.error ?? "The request failed.");
          return;
        }
        if (outcome.commandId) {
          const commandId = outcome.commandId;
          receipts.current.get(commandId)?.();
          receipts.current.delete(commandId);
          // Bound commands the machine never answers; terminal states (refused or
          // acked) drop themselves so a confirmed unarchive holds no listener.
          while (receipts.current.size >= 20) {
            const oldest = receipts.current.keys().next();
            if (oldest.done) break;
            receipts.current.get(oldest.value)?.();
            receipts.current.delete(oldest.value);
          }
          receipts.current.set(
            commandId,
            watchInboxReceipt(
              client,
              commandId,
              (error) => {
                receipts.current.delete(commandId);
                setProblem(
                  error !== undefined && error !== ""
                    ? `Your machine refused it (${error}).`
                    : "Your machine refused it.",
                );
              },
              () => {
                receipts.current.delete(commandId);
              },
            ),
          );
        }
        notify?.("Unarchived. The row returns once your machine confirms it.");
      } finally {
        setBusyId(null);
      }
    },
    [busyId, client, now, operate, notify],
  );

  const footerKind = archiveFooterKind(list, connection ?? "");
  return (
    <View style={{ flex: 1 }}>
      <FlashList
        data={list.ids}
        keyExtractor={(id) => id}
        onEndReached={() => {
          if (list.more && !list.loading) void more();
        }}
        onEndReachedThreshold={0.5}
        renderItem={({ item: id }) => (
          <View testID={`archive.${id}`}>
            <ArchiveRow
              id={id}
              store={lease.store}
              open={open}
              now={now}
              operate={operate}
              unarchive={(rowId) => void unarchive(rowId)}
              busy={busyId !== null}
            />
          </View>
        )}
        ListFooterComponent={
          <View style={{ padding: tokens.spacing.xl, gap: tokens.spacing.sm }}>
            {footerKind === "loading" ? (
              <Text
                style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}
                accessibilityLabel="Loading archived threads"
              >
                Loading archived threads…
              </Text>
            ) : footerKind === "failed" ? (
              <Pressable
                testID="archive.retry"
                accessibilityRole="button"
                accessibilityLabel="Retry loading older threads"
                onPress={() => void retry()}
                style={{ minHeight: tokens.dimensions.touchTarget, justifyContent: "center" }}
              >
                <Text style={{ ...textStyle("body"), color: theme.colours.accent }}>
                  Retry loading older threads
                </Text>
              </Pressable>
            ) : footerKind === "offline" ? (
              <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}>
                Can&apos;t reach this machine. Archived threads load once it&apos;s connected.
              </Text>
            ) : footerKind === "empty" ? (
              <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}>
                Nothing archived. Threads you archive on this machine wait here.
              </Text>
            ) : footerKind === "more" ? (
              <Pressable
                testID="archive.more"
                accessibilityRole="button"
                accessibilityLabel="Show older archived threads"
                onPress={() => void more()}
                style={{ minHeight: tokens.dimensions.touchTarget, justifyContent: "center" }}
              >
                <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
                  Show older archived threads
                </Text>
              </Pressable>
            ) : null}
            {operate ? null : (
              <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
                This phone can only view this machine.
              </Text>
            )}
            {problem ? (
              <Text style={{ ...textStyle("caption"), color: theme.statusText.failed }}>
                {problem}
              </Text>
            ) : null}
          </View>
        }
      />
    </View>
  );
}
