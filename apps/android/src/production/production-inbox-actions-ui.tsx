import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { textStyle, tokens, useTheme } from "../theme.tsx";
import { AceText } from "../components.tsx";
import type { InboxActionKind, SnoozePresetId } from "../inbox-actions.ts";
import { snoozeOptions } from "../inbox-actions.ts";
import {
  productionInboxRefusalCopy,
  runProductionInboxAction,
  watchProductionInboxReceipt,
  type ProductionInboxActionsStartup,
} from "./production-inbox-actions.ts";
import { undoActionFor } from "../inbox-actions.ts";

/**
 * Shared production inbox action state (single + merged views).
 *
 * One hook owns the Undo toast and the retryable failure banner so both inbox
 * views share the same safe behavior: every tap re-resolves the current grant
 * for the exact host inside `runProductionInboxAction` (fresh gate, no cached
 * handle), admitted settle/archive offer a 5s Undo, and daemon refusals clear
 * Undo and surface a retryable banner. View-only phones never reach `act`:
 * rows hide their buttons when `canAct` is not explicitly true.
 */

export interface ProductionInboxUndo {
  hostId: string;
  threadId: string;
  kind: InboxActionKind;
  commandId: string;
  label: string;
}

export interface ProductionInboxFailed {
  hostId: string;
  threadId: string;
  kind: InboxActionKind;
  preset?: SnoozePresetId | undefined;
  message: string;
}

export function useProductionInboxActions(startup: ProductionInboxActionsStartup) {
  const [undo, setUndo] = useState<ProductionInboxUndo | null>(null);
  const [failed, setFailed] = useState<ProductionInboxFailed | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const busyRef = useRef<Record<string, boolean>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function arm(offer: ProductionInboxUndo): void {
    if (timer.current !== null) clearTimeout(timer.current);
    setUndo(offer);
    timer.current = setTimeout(() => setUndo(null), 5000);
  }

  async function act(
    hostId: string,
    kind: InboxActionKind,
    threadId: string,
    preset?: SnoozePresetId | undefined,
  ): Promise<string | null> {
    const key = `${hostId}:${threadId}:${kind}`;
    if (busyRef.current[key] === true) return null;
    busyRef.current = { ...busyRef.current, [key]: true };
    setBusy((prev) => ({ ...prev, [key]: true }));
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
        const message = outcome.error ?? "Could not save the request on this device.";
        setFailed({ hostId, threadId, kind, preset, message });
        return message;
      }
      setFailed(null);
      const undoKind = undoActionFor(kind);
      if (undoKind !== undefined) {
        arm({
          hostId,
          threadId,
          kind,
          commandId: outcome.commandId,
          label: kind === "archive" ? "Thread archived" : "Thread settled",
        });
      }
      watchProductionInboxReceipt(
        startup,
        hostId,
        outcome.commandId,
        (error) => {
          setUndo((current) =>
            current !== null && current.commandId === outcome.commandId ? null : current,
          );
          setFailed({
            hostId,
            threadId,
            kind,
            preset,
            message: productionInboxRefusalCopy(error),
          });
        },
        () => {},
      );
      return null;
    } finally {
      const nextRef = { ...busyRef.current };
      delete nextRef[key];
      busyRef.current = nextRef;
      setBusy((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  async function undoNow(): Promise<string | null> {
    const current = undo;
    if (!current) return null;
    const undoKind = undoActionFor(current.kind);
    if (undoKind === undefined) {
      setUndo(null);
      return null;
    }
    setUndo(null);
    return act(current.hostId, undoKind, current.threadId);
  }

  async function retryFailed(): Promise<string | null> {
    const current = failed;
    if (!current) return null;
    setFailed(null);
    return act(current.hostId, current.kind, current.threadId, current.preset);
  }

  function dismissFailed(): void {
    setFailed(null);
  }

  function isBusy(hostId: string, threadId: string): boolean {
    return Object.keys(busy).some((key) => key.startsWith(`${hostId}:${threadId}:`));
  }

  return { undo, failed, busy, isBusy, act, undoNow, retryFailed, dismissFailed };
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
  const button = (label: string, key: string, press: () => void) => (
    <Pressable
      key={key}
      onPress={press}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        paddingHorizontal: tokens.spacing.md,
        paddingVertical: tokens.spacing.xs,
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
        {offered.settle ? button("Settle", "settle", () => onAct("settle")) : null}
        {offered.unsettle ? button("Unsettle", "unsettle", () => onAct("unsettle")) : null}
        {offered.snooze && !snoozing ? button("Snooze", "snooze", () => setSnoozing(true)) : null}
        {offered.wake ? button("Wake", "wake", () => onAct("wake")) : null}
        {offered.archive ? button("Archive", "archive", () => onAct("archive")) : null}
      </View>
      {offered.snooze && snoozing ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.spacing.xs }}>
          {presets.map((option) =>
            button(`${option.label} · ${option.detail}`, option.id, () =>
              onAct("snooze", option.id),
            ),
          )}
        </View>
      ) : null}
      <AceText role="caption">The row moves once your machine confirms it.</AceText>
    </View>
  );
}
