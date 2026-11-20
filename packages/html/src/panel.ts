import {
  PanelPageMessage,
  panelRuntime,
  type PanelInit,
  type PanelState,
  type PanelTheme,
} from "@ace/protocol";
import { themeMessage, type HtmlTheme } from "./document.ts";
import { panelText } from "./scripts.ts";

/*
 * The host's half of a package panel's channel (ADR 0200 §5.2): every message from the page is
 * JSON text measured in bytes before it is parsed, then checked with its schema, and an action
 * only when its panel declares it; the messages into the page are built here; a watchdog stops a
 * page that throws or stalls three times; and an action the panel declares `confirm` waits on
 * ace's own line outside the page, where only the person's real press sends it (amendment 1).
 * Pure: the clock and the press are the caller's.
 */

/**
 * A page message the host acts on: JSON text of at most `panelMessageBytes` UTF-8 bytes (the
 * bridges relay only text), of a type the channel has. Anything else, or an action the panel
 * doesn't declare, is none.
 */
export function readPanelMessage(
  raw: unknown,
  actions: ReadonlySet<string>,
): PanelPageMessage | undefined {
  const text = panelText(raw);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const read = PanelPageMessage.safeParse(parsed);
  if (!read.success) return undefined;
  if (read.data.type === "ace.panel.action" && !actions.has(read.data.name)) return undefined;
  return read.data;
}

/** An action the panel declares `confirm`, waiting on the person's press on ace's own line. */
export interface PanelConfirm {
  readonly name: string;
  readonly value: unknown;
  /** The line's words: the panel, the action and its value. */
  readonly words: string;
  /** When the line appeared. */
  readonly shownAt: number;
}

/**
 * How long the line shows before Confirm takes a press, so a page can't draw a button where
 * Confirm will appear and have the person's press on it land there.
 */
export const panelConfirmArmMs = 600;
/** The most of a value the line shows; the rest is in its full text. */
const valueChars = 80;

/** A value in words: text as it is, anything else as compact JSON, on one line. */
function valueWords(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim();
}

/** The line that asks the person, for `label` from panel `title` with `value`. */
export function panelConfirm(
  title: string,
  action: { name: string; label: string },
  value: unknown,
  shownAt: number,
): PanelConfirm {
  const words = valueWords(value);
  const shown = words.length > valueChars ? `${words.slice(0, valueChars - 1)}…` : words;
  return {
    name: action.name,
    value,
    words: `${title} asks to send “${action.label}”${shown ? ` with ${shown}` : ""}.`,
    shownAt,
  };
}

/**
 * Whether a press on Confirm sends the action as the person's: only a real input event the
 * browser made (never one a script dispatched), and only once the line has shown for
 * `panelConfirmArmMs`.
 */
export function panelConfirmPressed(
  press: { trusted: boolean; at: number },
  confirm: PanelConfirm,
): boolean {
  return press.trusted && press.at - confirm.shownAt >= panelConfirmArmMs;
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
