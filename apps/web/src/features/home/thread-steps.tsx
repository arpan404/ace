import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { focusComposerSoon } from "@/lib/focus-composer.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { machineListId, machineRow, useMachineEntries } from "@/lib/machine-threads.ts";
import { ThreadLeaveContext } from "@/lib/thread-leave.ts";
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

/**
 * Where to go when `id` leaves the list: the thread after it, else the one before it (it was
 * last); the top of the list when it wasn't listed; nothing when no other thread is.
 */
export function threadAfterLeaving(order: readonly string[], id: string): string | undefined {
  const at = order.indexOf(id);
  if (at < 0) return order[0];
  return order[at + 1] ?? (at > 0 ? order[at - 1] : undefined);
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
 * Other machines' threads are in that order as Home lists them, and open on their machine
 * (ADR 0100).
 */
export function useThreadSteps() {
  const own = useHostIdentity()?.hostId;
  const list = useHomeList(useMachineEntries(own));
  const threadId = useParams({ strict: false }).threadId;
  // `?machine=` naming this window's own daemon is this window's own thread.
  const machine = useLocation({
    select: (location) => {
      const search: { machine?: unknown } = location.search;
      return typeof search.machine === "string" && search.machine !== own
        ? search.machine
        : undefined;
    },
  });
  const current = threadId && machine ? machineListId(machine, threadId) : threadId;
  const navigate = useNavigate();
  const order = useMemo(
    () => [...list.pinned, ...list.active, ...list.recent],
    [list.pinned, list.active, list.recent],
  );
  const needsYou = useMemo(() => new Set(list.needsYou), [list.needsYou]);
  const go = (id: string | undefined) => {
    if (!id) return;
    const ref = machineRow(id);
    void navigate(ref ? threadOn(ref.hostId, ref.threadId) : threadOn(undefined, id));
  };
  return {
    next: () => go(stepThread(order, current, 1)),
    previous: () => go(stepThread(order, current, -1)),
    nextNeedsYou: () => go(nextNeedingYou(order, needsYou, current)),
    /** `id` has left the list: open its neighbour with the caret in its composer, else Home. */
    leave: (id: string) => {
      // The open thread's screen names it by its own id, on whichever machine it is.
      const to = threadAfterLeaving(order, id === threadId && current ? current : id);
      if (!to) return void navigate({ to: "/" });
      go(to);
      focusComposerSoon();
    },
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

/**
 * Gives the thread screen its leave step (`lib/thread-leave.ts`): archiving the open thread
 * opens the next one in this list's order. The value is stable across list changes, so the
 * screens reading it never re-render for them.
 */
export function ThreadLeaveProvider(props: { children: ReactNode }) {
  const steps = useThreadSteps();
  const latest = useRef(steps.leave);
  useLayoutEffect(() => {
    latest.current = steps.leave;
  });
  const leave = useCallback((id: string) => latest.current(id), []);
  return <ThreadLeaveContext.Provider value={leave}>{props.children}</ThreadLeaveContext.Provider>;
}
