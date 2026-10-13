import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useHomeList } from "./use-home-threads.ts";

/**
 * The thread `delta` places from `current` in the sidebar's order: the first (or last) when
 * the open screen isn't one of them, nothing past either end.
 */
export function stepThread(
  order: readonly string[],
  current: string | undefined,
  delta: 1 | -1,
): string | undefined {
  const at = current === undefined ? -1 : order.indexOf(current);
  if (at < 0) return delta > 0 ? order[0] : order.at(-1);
  return order[at + delta];
}

/** The next thread after `current` (wrapping round) that needs the person. */
export function nextNeedingYou(
  order: readonly string[],
  needsYou: ReadonlySet<string>,
  current: string | undefined,
): string | undefined {
  const at = current === undefined ? -1 : order.indexOf(current);
  for (let step = 1; step <= order.length; step++) {
    const id = order[(at + step + order.length) % order.length];
    if (id !== undefined && id !== current && needsYou.has(id)) return id;
  }
  return undefined;
}

/**
 * Moving between threads in the sidebar's order (pinned, then the work in hand, then recent;
 * snoozed and settled stay folded away): the next, the previous, and the next that needs you.
 */
export function useThreadSteps() {
  const list = useHomeList();
  const current = useParams({ strict: false }).threadId;
  const navigate = useNavigate();
  const order = useMemo(
    () => [...list.pinned, ...list.active, ...list.recent],
    [list.pinned, list.active, list.recent],
  );
  const needsYou = useMemo(() => new Set(list.needsYou), [list.needsYou]);
  const go = (id: string | undefined) => {
    if (id) void navigate({ to: "/t/$threadId", params: { threadId: id } });
  };
  return {
    next: () => go(stepThread(order, current, 1)),
    previous: () => go(stepThread(order, current, -1)),
    nextNeedsYou: () => go(nextNeedingYou(order, needsYou, current)),
    /** Whether another thread needs the person now. */
    othersNeedYou: nextNeedingYou(order, needsYou, current) !== undefined,
  };
}

/** ⌥⌘↓ and ⌥⌘↑ move to the next and previous thread; ⌥⌘J to the next that needs you. */
export function ThreadStepKeys() {
  const steps = useThreadSteps();
  useHotkey(keymap.nextThread.keys, steps.next);
  useHotkey(keymap.previousThread.keys, steps.previous);
  useHotkey(keymap.nextNeedsYou.keys, steps.nextNeedsYou);
  return null;
}
