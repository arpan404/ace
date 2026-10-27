import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { textStyle, tokens, useTheme } from "../theme.tsx";
import { AceText } from "../components.tsx";
import type { InboxActionKind, SnoozePresetId } from "../inbox-actions.ts";
import { snoozeOptions } from "../inbox-actions.ts";
import {
  inboxUndoAccessibilityLabel,
  PRODUCTION_INBOX_VIEW_ONLY_COPY,
  productionInboxRefusalCopy,
  runProductionInboxAction,
  watchProductionInboxReceipt,
  withHostAttribution,
  type ProductionInboxActionsStartup,
} from "./production-inbox-actions.ts";
import {
  armUiUndo,
  clearUiUndoForCommand,
  consumeUiFailedForRetry,
  dismissInboxActionFailed,
  isInboxActionBusy,
  readInboxActionUi,
  reportUiFailed,
  setUiBusy,
  subscribeInboxActionUi,
  takeInboxActionFailed,
  trackInboxActionReceipt,
  untrackInboxActionReceipt,
  type ProductionInboxActionUiOptions,
  type ProductionInboxFailed,
  type ProductionInboxUndo,
} from "./production-inbox-actions-store.ts";
import { undoActionFor } from "../inbox-actions.ts";

export type { ProductionInboxActionUiOptions, ProductionInboxFailed, ProductionInboxUndo };

/**
 * Shared production inbox action state (single + merged views).
 *
 * One hook owns the Undo toast and the retryable failure banner so both inbox
 * views share the same safe behavior: every tap re-resolves the current grant
 * for the exact host inside `runProductionInboxAction` (fresh gate, no cached
 * handle), admitted settle/archive offer a 5s Undo, and daemon refusals clear
 * Undo and surface a retryable banner. View-only phones never reach `act`:
 * rows hide their buttons when `canAct` is not explicitly true.
 *
 * Remount-safe: the toast, the failure queue and the in-flight set live in
 * `production-inbox-actions-store.ts` (like `interactions.ts` resolutions), so
 * rotation or a view remount inside the 5s Undo window keeps the offer and
 * the receipt path. The command itself stays durable in the outbox regardless.
 */

function dismissInboxFailedBanner(visibleFailed: ProductionInboxFailed | null = null): void {
  dismissInboxActionFailed(visibleFailed);
}

/** Read the current grant for one host, fail-closed on throws and unknowns. */
function canOperateForHost(startup: ProductionInboxActionsStartup, hostId: string): boolean {
  try {
    return startup.canOperate(hostId) === true;
  } catch {
    return false;
  }
}

/** Whether the given host has an in-flight action on the given thread. */
function inboxActionIsBusy(hostId: string, threadId: string): boolean {
  return isInboxActionBusy(hostId, threadId);
}

export function useProductionInboxActions(
  startup: ProductionInboxActionsStartup,
  options: ProductionInboxActionUiOptions = {},
) {
  const [, setVersion] = useState(0);
  useEffect(
    () =>
      subscribeInboxActionUi(() => {
        setVersion((value) => value + 1);
      }),
    [],
  );
  const { undo, failed, busy } = readInboxActionUi();

  async function act(
    hostId: string,
    kind: InboxActionKind,
    threadId: string,
    preset?: SnoozePresetId | undefined,
  ): Promise<string | null> {
    const key = `${hostId}:${threadId}:${kind}`;
    if (readInboxActionUi().busy[key] === true) return null;
    setUiBusy(key, true, hostId, threadId);
    try {
      const outcome = await runProductionInboxAction(
        startup,
        hostId,
        kind,
        threadId,
        Date.now(),
        preset,
      );
      if (!outcome.admitted || !outcome.commandId) {
        const raw = outcome.error ?? "Could not save the request on this device.";
        reportUiFailed({
          hostId,
          threadId,
          kind,
          preset,
          message: withHostAttribution(raw, hostId, options.hostLabel),
        });
        return withHostAttribution(raw, hostId, options.hostLabel);
      }
      const undoKind = undoActionFor(kind);
      if (undoKind !== undefined) {
        armUiUndo({
          hostId,
          threadId,
          kind,
          commandId: outcome.commandId,
          label: kind === "archive" ? "Thread archived" : "Thread settled",
        });
      }
      const commandId = outcome.commandId;
      let firedSynchronously = false;
      const stop = watchProductionInboxReceipt(
        startup,
        hostId,
        commandId,
        (error) => {
          firedSynchronously = true;
          untrackInboxActionReceipt(hostId, commandId);
          clearUiUndoForCommand(hostId, commandId);
          reportUiFailed({
            hostId,
            threadId,
            kind,
            preset,
            message: withHostAttribution(
              productionInboxRefusalCopy(error),
              hostId,
              options.hostLabel,
            ),
          });
        },
        () => {
          firedSynchronously = true;
          untrackInboxActionReceipt(hostId, commandId);
        },
      );
      if (!firedSynchronously) {
        trackInboxActionReceipt(hostId, commandId, stop);
      } else {
        try {
          stop();
        } catch {
          /* terminal already cleaned */
        }
      }
      return null;
    } finally {
      setUiBusy(key, false);
    }
  }

  async function undoNow(visibleUndo?: ProductionInboxUndo | null): Promise<string | null> {
    const current = visibleUndo === undefined ? readInboxActionUi().undo : visibleUndo;
    if (!current) return null;
    const undoKind = undoActionFor(current.kind);
    if (undoKind === undefined) {
      clearUiUndoForCommand(current.hostId, current.commandId);
      return null;
    }
    // A grant revoked after the row mounted must not destroy the offer:
    // keep it stored (and hidden by the views) instead of clearing it into a
    // fail-closed refusal.
    if (!canOperateForHost(startup, current.hostId)) {
      return PRODUCTION_INBOX_VIEW_ONLY_COPY;
    }
    clearUiUndoForCommand(current.hostId, current.commandId);
    const issue = await act(current.hostId, undoKind, current.threadId);
    if (issue === PRODUCTION_INBOX_VIEW_ONLY_COPY) {
      // Lost the grant between the check and the tap: restore the offer.
      armUiUndo(current);
    }
    return issue;
  }

  async function retryFailed(visibleFailed?: ProductionInboxFailed | null): Promise<string | null> {
    const current =
      visibleFailed === undefined
        ? consumeUiFailedForRetry()
        : visibleFailed === null
          ? null
          : takeInboxActionFailed(visibleFailed);
    if (!current) return null;
    if (!canOperateForHost(startup, current.hostId)) {
      reportUiFailed(current);
      return PRODUCTION_INBOX_VIEW_ONLY_COPY;
    }
    return act(current.hostId, current.kind, current.threadId, current.preset);
  }

  return {
    undo,
    failed,
    busy,
    isBusy: inboxActionIsBusy,
    act,
    undoNow,
    retryFailed,
    dismissFailed: (visibleFailed?: ProductionInboxFailed | null) =>
      dismissInboxFailedBanner(visibleFailed ?? null),
  };
}

/** Undo toast plus retryable failure banner, shared by both production inboxes. */
export function ProductionInboxActionBanner({
  undo,
  failed,
  onUndo,
  onRetry,
  onDismissFailed,
}: {
  undo: ProductionInboxUndo | null;
  failed: ProductionInboxFailed | null;
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
          accessibilityLabel={inboxUndoAccessibilityLabel(undo)}
          accessibilityHint={`Takes back the ${undo.kind === "archive" ? "archived" : "settled"} thread`}
          style={{
            paddingHorizontal: tokens.spacing.md,
            paddingVertical: tokens.spacing.sm,
            minHeight: tokens.dimensions.touchTarget,
            justifyContent: "center",
          }}
        >
          <Text style={{ ...textStyle("label"), color: theme.colours.background }}>Undo</Text>
        </Pressable>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry inbox action"
            accessibilityHint="Sends the failed inbox action again"
            style={{
              paddingHorizontal: tokens.spacing.md,
              paddingVertical: tokens.spacing.sm,
              minHeight: tokens.dimensions.touchTarget,
              justifyContent: "center",
            }}
          >
            <Text style={{ ...textStyle("label"), color: theme.colours.background }}>Retry</Text>
          </Pressable>
          <Pressable
            onPress={onDismissFailed}
            accessibilityRole="button"
            accessibilityLabel="Dismiss inbox error"
            style={{
              paddingHorizontal: tokens.spacing.md,
              paddingVertical: tokens.spacing.sm,
              minHeight: tokens.dimensions.touchTarget,
              justifyContent: "center",
            }}
          >
            <Text style={{ ...textStyle("label"), color: theme.colours.background }}>Dismiss</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** Inline organize buttons for one production row; hidden while view-only. */
export function ProductionInboxRowActions({
  offered,
  busy,
  now,
  onAct,
}: {
  offered: { settle: boolean; unsettle: boolean; snooze: boolean; wake: boolean; archive: boolean };
  busy: boolean;
  now: number;
  onAct(kind: InboxActionKind, preset?: SnoozePresetId): void;
}) {
  const theme = useTheme();
  const [snoozing, setSnoozing] = useState(false);
  const presets = useMemo(() => snoozeOptions(now), [now]);
  if (
    !offered.settle &&
    !offered.unsettle &&
    !offered.snooze &&
    !offered.wake &&
    !offered.archive
  ) {
    return null;
  }
  const button = (label: string, key: string, hint: string, press: () => void) => (
    <Pressable
      key={key}
      onPress={press}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={{
        paddingHorizontal: tokens.spacing.md,
        paddingVertical: tokens.spacing.sm,
        minHeight: tokens.dimensions.touchTarget,
        justifyContent: "center",
        borderRadius: tokens.radii.pill,
        borderWidth: tokens.dimensions.border,
        borderColor: theme.colours.separator,
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Text style={{ ...textStyle("caption"), color: theme.colours.foreground }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: tokens.spacing.xs, paddingTop: tokens.spacing.xs }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.spacing.xs }}>
        {offered.settle
          ? button("Settle", "settle", "Marks this thread settled", () => onAct("settle"))
          : null}
        {offered.unsettle
          ? button("Unsettle", "unsettle", "Brings this settled thread back", () =>
              onAct("unsettle"),
            )
          : null}
        {offered.snooze && !snoozing
          ? button("Snooze", "snooze", "Shows snooze times", () => setSnoozing(true))
          : null}
        {offered.wake
          ? button("Wake", "wake", "Brings this snoozed thread back now", () => onAct("wake"))
          : null}
        {offered.archive
          ? button("Archive", "archive", "Archives this thread", () => onAct("archive"))
          : null}
      </View>
      {offered.snooze && snoozing ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.spacing.xs }}>
          {presets.map((option) =>
            button(
              `${option.label} · ${option.detail}`,
              option.id,
              `Snoozes until ${option.label}`,
              () => onAct("snooze", option.id),
            ),
          )}
        </View>
      ) : null}
      <AceText role="caption">The row moves once your machine confirms it.</AceText>
    </View>
  );
}
