import {
  panelConfirm,
  panelConfirmPressed,
  panelFaulted,
  panelInit,
  panelMayAct,
  panelPingMs,
  panelPonged,
  panelState,
  panelTick,
  panelWatch,
  readPanelMessage,
  type HtmlTheme,
  type PanelConfirm,
  type PanelWatch,
} from "@ace/html";
import type { PanelHostMessage } from "@ace/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelChannel } from "@/features/visualization/index.ts";

/*
 * The host's side of one open panel (ADR 0200 §5.2): it sends the page `init` (the person's theme,
 * scheme, motion and the panel's size) and the bot's state, every change of either after, and a
 * watchdog ping; it reads what comes back through `@ace/html`'s checks, so only an action the
 * panel declares goes on, within its budget. What the page sends is the page's (`onAction`), never
 * the person's: an action the panel declares `confirm` instead waits on ace's own line outside the
 * page (`confirm`), and only a real press on its Confirm sends it as the person's (`onConfirmed`;
 * amendment 1). A page that throws or stalls three times is stopped until the person loads it
 * again.
 */

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** A press the browser made from real input, never one a script dispatched. */
const inputTrusted = (event: Event) => event.isTrusted;

/** The line ace draws outside the page for an action only the person may send. */
export interface PanelConfirmLine {
  words: string;
  /** The person pressed Confirm: `event` is the press, checked before anything goes. */
  press(event: Event): void;
  cancel(): void;
}

export function usePanelHost(input: {
  title: string;
  actions: readonly string[];
  /** The actions only the person may send, with their words. */
  confirm: readonly { name: string; label: string }[];
  state: unknown;
  theme: HtmlTheme;
  size: { width: number; height: number };
  /** An action the page sent: the page's, never the person's. */
  onAction(name: string, value: unknown): void;
  /** An action the person confirmed on ace's own line. */
  onConfirmed(name: string, value: unknown): void;
  /** The clock the watchdog and the confirm line read; the page's own by default. */
  now?: () => number;
  /** Whether a press came from real input; the event's own word by default. */
  trusted?: (event: Event) => boolean;
}): {
  channel: PanelChannel;
  stopped: boolean;
  generation: number;
  reload(): void;
  confirm: PanelConfirmLine | undefined;
} {
  const [stopped, setStopped] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [asking, setAsking] = useState<PanelConfirm | undefined>(undefined);
  const watch = useRef<PanelWatch>(panelWatch);
  const pending = useRef<PanelConfirm | undefined>(undefined);
  const send = useRef<((message: PanelHostMessage) => void) | undefined>(undefined);
  // The latest of everything, read when the page asks or sends: a channel itself never changes.
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const clock = useCallback(() => (latest.current.now ?? (() => performance.now()))(), []);
  const ask = useCallback((next: PanelConfirm | undefined) => {
    pending.current = next;
    setAsking(next);
  }, []);
  const settle = useCallback(
    (next: PanelWatch) => {
      watch.current = next;
      if (next.stopped) {
        send.current = undefined;
        ask(undefined);
        setStopped(true);
      }
    },
    [ask],
  );
  const open = (): PanelChannel => ({
    onReady(sender) {
      send.current = sender;
      if (!sender) return;
      const { theme, size, state } = latest.current;
      sender(panelInit(theme, reducedMotion(), size));
      if (state !== undefined) sender(panelState(state));
    },
    onMessage(raw) {
      if (watch.current.stopped) return;
      const message = readPanelMessage(raw, new Set(latest.current.actions));
      if (!message) return;
      switch (message.type) {
        case "ace.panel.fault":
          return settle(panelFaulted(watch.current));
        case "ace.panel.pong":
          return settle(panelPonged(watch.current, message.n));
        case "ace.panel.action": {
          const asked = panelMayAct(watch.current, clock());
          settle(asked.watch);
          if (!asked.ok) return;
          const needs = latest.current.confirm.find((each) => each.name === message.name);
          if (!needs) return latest.current.onAction(message.name, message.value);
          // One line at a time: a page can't swap what the person is about to confirm.
          if (pending.current) return;
          ask(panelConfirm(latest.current.title, needs, message.value, clock()));
          return;
        }
        case "ace.html.height":
          return;
      }
    },
  });
  // A page loaded again gets a channel of its own.
  const [channel, setChannel] = useState(open);
  // The bot's state, whenever it changes.
  useEffect(() => {
    if (input.state !== undefined) send.current?.(panelState(input.state));
  }, [input.state]);
  // The watchdog, while the page is up.
  useEffect(() => {
    if (stopped) return;
    const timer = setInterval(() => {
      if (!send.current) return;
      const ticked = panelTick(watch.current, clock());
      settle(ticked.watch);
      if (ticked.ping !== undefined) send.current?.({ type: "ace.panel.ping", n: ticked.ping });
    }, panelPingMs);
    return () => clearInterval(timer);
  }, [stopped, clock, settle]);
  return {
    channel,
    stopped,
    generation,
    reload() {
      watch.current = panelWatch;
      send.current = undefined;
      ask(undefined);
      setStopped(false);
      setGeneration((count) => count + 1);
      setChannel(open());
    },
    confirm: asking && {
      words: asking.words,
      press(event) {
        const line = pending.current;
        if (!line) return;
        const trusted = (latest.current.trusted ?? inputTrusted)(event);
        if (!panelConfirmPressed({ trusted, at: clock() }, line)) return;
        ask(undefined);
        latest.current.onConfirmed(line.name, line.value);
      },
      cancel: () => ask(undefined),
    },
  };
}
