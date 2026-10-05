import { useSyncExternalStore } from "react";
import { z } from "zod";

/*
 * Plugin removals waiting out their Undo, kept in localStorage (`ace.skills.removing`) per daemon
 * so a reload or a closed window inside the window can't lose a confirmed removal. Each entry
 * hides its plugin from that daemon's catalog; at its deadline the removal is sent. Entries
 * whose window passed while the app was closed are sent when Skills next connects
 * (`reconcileRemovals`).
 */

/** How long Undo is offered, matching an actionable toast. */
export const undoWindowMs = 8_000;

const storageKey = "ace.skills.removing";
const Journal = z.array(
  z.object({ daemon: z.string().max(2048), plugin: z.string().max(64), deadline: z.number() }),
);
type Entry = z.infer<typeof Journal>[number];

const listeners = new Set<() => void>();
let cached: { raw: string | null; entries: readonly Entry[] } | undefined;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(): readonly Entry[] {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(storageKey) ?? null;
  } catch {
    raw = null;
  }
  if (cached && cached.raw === raw) return cached.entries;
  let entries: readonly Entry[] = [];
  try {
    const parsed = Journal.safeParse(JSON.parse(raw ?? "[]"));
    entries = parsed.success ? parsed.data : [];
  } catch {
    entries = [];
  }
  cached = { raw, entries };
  return entries;
}

function write(next: readonly Entry[]) {
  try {
    if (next.length) storage()?.setItem(storageKey, JSON.stringify(next));
    else storage()?.removeItem(storageKey);
  } catch {
    // Storage unavailable: the removal still runs from this window's timer.
    cached = { raw: null, entries: next };
  }
  for (const listener of listeners) listener();
}

const same = (entry: Entry, daemon: string, plugin: string) =>
  entry.daemon === daemon && entry.plugin === plugin;

function drop(daemon: string, plugin: string) {
  write(read().filter((entry) => !same(entry, daemon, plugin)));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

const hiddenCache = new Map<string, { entries: readonly Entry[]; plugins: ReadonlySet<string> }>();

/** The plugins `daemon`'s catalog leaves out because their removal is under way. */
function hiddenFor(daemon: string): ReadonlySet<string> {
  const entries = read();
  const known = hiddenCache.get(daemon);
  if (known?.entries === entries) return known.plugins;
  const plugins = new Set(
    entries.filter((entry) => entry.daemon === daemon).map((entry) => entry.plugin),
  );
  hiddenCache.set(daemon, { entries, plugins });
  return plugins;
}

export function useRemovingPlugins(daemon: string): ReadonlySet<string> {
  const get = () => hiddenFor(daemon);
  return useSyncExternalStore(subscribe, get, get);
}

export interface RemovalRunner {
  /** Send the removal; resolves once the daemon has removed it. */
  remove(plugin: string): Promise<void>;
  /** Whether the daemon can be asked now; a removal that fails offline waits for reconnect. */
  online(): boolean;
  failed(plugin: string, error: unknown): void;
}

/** This window's timer for each pending removal, with the deadline it was set for. */
const timers = new Map<string, { deadline: number; timer: ReturnType<typeof setTimeout> }>();
/** Removals being sent now; nothing arms them again until they settle. */
const sending = new Set<string>();
const timerKey = (daemon: string, plugin: string) => `${daemon}\u0000${plugin}`;

function clearTimer(daemon: string, plugin: string) {
  const key = timerKey(daemon, plugin);
  clearTimeout(timers.get(key)?.timer);
  timers.delete(key);
}

async function run(daemon: string, plugin: string, runner: RemovalRunner) {
  const key = timerKey(daemon, plugin);
  clearTimer(daemon, plugin);
  // Undone meanwhile, already being sent, or already sent from another window.
  if (sending.has(key) || !read().some((entry) => same(entry, daemon, plugin))) return;
  sending.add(key);
  try {
    await runner.remove(plugin);
    drop(daemon, plugin);
  } catch (error) {
    // Offline: keep it for the next connection. Refused: the plugin comes back, and says why.
    if (runner.online()) {
      drop(daemon, plugin);
      runner.failed(plugin, error);
    }
  } finally {
    sending.delete(key);
  }
}

function arm(entry: Entry, runner: RemovalRunner, now: number) {
  const key = timerKey(entry.daemon, entry.plugin);
  if (sending.has(key) || timers.get(key)?.deadline === entry.deadline) return;
  clearTimeout(timers.get(key)?.timer);
  timers.set(key, {
    deadline: entry.deadline,
    timer: setTimeout(
      () => void run(entry.daemon, entry.plugin, runner),
      Math.max(0, entry.deadline - now),
    ),
  });
}

/** Hide `plugin` now and remove it from `daemon` once Undo has gone. */
export function scheduleRemoval(
  daemon: string,
  plugin: string,
  runner: RemovalRunner,
  now: number,
): void {
  const entry = { daemon, plugin, deadline: now + undoWindowMs };
  write([...read().filter((other) => !same(other, daemon, plugin)), entry]);
  arm(entry, runner, now);
}

/** Undo: the plugin stays installed and shows again. */
export function undoRemoval(daemon: string, plugin: string): void {
  clearTimer(daemon, plugin);
  drop(daemon, plugin);
}

/** Send a pending removal now (its toast was dismissed). */
export function removeNow(daemon: string, plugin: string, runner: RemovalRunner): void {
  void run(daemon, plugin, runner);
}

/**
 * Pick up removals this window doesn't hold a timer for: ones confirmed before a reload, or
 * that failed offline. Overdue ones are sent at once, the rest at their deadline.
 */
export function reconcileRemovals(daemon: string, runner: RemovalRunner, now: number): void {
  for (const entry of read()) if (entry.daemon === daemon) arm(entry, runner, now);
}
