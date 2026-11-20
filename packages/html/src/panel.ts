import {
  PanelPageMessage,
  panelRuntime,
  type PanelInit,
  type PanelState,
  type PanelTheme,
} from "@ace/protocol";
import { themeMessage, type HtmlTheme } from "./document.ts";

/*
 * The host's half of a package panel's channel (ADR 0200 §5.2). Every message from the page is
 * checked with its schema, and an action only when its panel declares it; the messages into the
 * page are built here; and a watchdog stops a page that throws or stalls three times. Pure: the
 * clock is the caller's.
 */

/** A page message the host acts on; anything else, or an action the panel doesn't declare, is none. */
export function readPanelMessage(
  raw: unknown,
  actions: ReadonlySet<string>,
): PanelPageMessage | undefined {
  const read = PanelPageMessage.safeParse(raw);
  if (!read.success) return undefined;
  if (read.data.type === "ace.panel.action" && !actions.has(read.data.name)) return undefined;
  return read.data;
}

const scheme = (theme: HtmlTheme) => theme.colorScheme ?? "dark";
/** The theme's tokens a page may use, each a value that can't leave its CSS declaration. */
const tokensOf = (theme: HtmlTheme): Record<string, string> =>
  Object.fromEntries(
    Object.entries(themeMessage(theme).tokens).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );

export function panelInit(
  theme: HtmlTheme,
  reduceMotion: boolean,
  size: { width: number; height: number },
): PanelInit {
  return {
    type: "ace.panel.init",
    runtime: panelRuntime,
    tokens: tokensOf(theme),
    scheme: scheme(theme),
    reduceMotion,
    size: { width: Math.round(size.width), height: Math.round(size.height) },
  };
}

export function panelTheme(theme: HtmlTheme): PanelTheme {
  return {
    type: "ace.panel.theme",
    tokens: tokensOf(theme),
    scheme: scheme(theme),
  };
}

export function panelState(data: unknown): PanelState {
  return { type: "ace.panel.state", data };
}

/** How often the host asks a live page to answer, and how long it waits before that's a stall. */
export const panelPingMs = 2000;
export const panelStallMs = 5000;
/** Throws and stalls before the page is stopped. */
export const panelStrikes = 3;
/** Actions a page may send in a window before the rest are dropped. */
export const panelActionBudget = { count: 8, windowMs: 10_000 };

export interface PanelWatch {
  readonly strikes: number;
  readonly stopped: boolean;
  /** The ping waiting for its answer, and when it went. */
  readonly waiting: { n: number; at: number } | undefined;
  readonly next: number;
  /** When each recent action went, for the budget. */
  readonly sent: readonly number[];
}

export const panelWatch: PanelWatch = {
  strikes: 0,
  stopped: false,
  waiting: undefined,
  next: 1,
  sent: [],
};

const strike = (watch: PanelWatch): PanelWatch => {
  const strikes = watch.strikes + 1;
  return { ...watch, strikes, stopped: strikes >= panelStrikes, waiting: undefined };
};

/** The page threw. */
export function panelFaulted(watch: PanelWatch): PanelWatch {
  return watch.stopped ? watch : strike(watch);
}

/**
 * Time passed to `at`: a ping unanswered past the stall time is a strike, and the watch says
 * which ping to send now, if one is due.
 */
export function panelTick(watch: PanelWatch, at: number): { watch: PanelWatch; ping?: number } {
  if (watch.stopped) return { watch };
  if (watch.waiting) {
    if (at - watch.waiting.at < panelStallMs) return { watch };
    return { watch: strike(watch) };
  }
  const n = watch.next;
  return { watch: { ...watch, waiting: { n, at }, next: n + 1 }, ping: n };
}

/** The page answered ping `n`. */
export function panelPonged(watch: PanelWatch, n: number): PanelWatch {
  return watch.waiting?.n === n ? { ...watch, waiting: undefined } : watch;
}

/** Whether an action may go now; the watch, counting it when it may. */
export function panelMayAct(watch: PanelWatch, at: number): { watch: PanelWatch; ok: boolean } {
  if (watch.stopped) return { watch, ok: false };
  const recent = watch.sent.filter((when) => at - when < panelActionBudget.windowMs);
  if (recent.length >= panelActionBudget.count)
    return { watch: { ...watch, sent: recent }, ok: false };
  return { watch: { ...watch, sent: [...recent, at] }, ok: true };
}
