import {
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
  type PanelWatch,
} from "@ace/html";
import type { PanelHostMessage } from "@ace/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelChannel } from "@/features/visualization/index.ts";

/*
 * The host's side of one open panel (ADR 0200 §5.2): it sends the page `init` (the person's theme,
 * scheme, motion and the panel's size) and the bot's state, every change of either after, and a
 * watchdog ping; it reads what comes back through `@ace/html`'s checks, so only an action the
 * panel declares reaches `onAction`, within its budget. A page that throws or stalls three times
 * is stopped until the person loads it again.
 */

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function usePanelHost(input: {
  actions: readonly string[];
  state: unknown;
  theme: HtmlTheme;
  size: { width: number; height: number };
  onAction(name: string, value: unknown): void;
  /** The clock the watchdog reads; the page's own by default. */
  now?: () => number;
}): { channel: PanelChannel; stopped: boolean; generation: number; reload(): void } {
  const [stopped, setStopped] = useState(false);
  const [generation, setGeneration] = useState(0);
  const watch = useRef<PanelWatch>(panelWatch);
  const send = useRef<((message: PanelHostMessage) => void) | undefined>(undefined);
  // The latest of everything, read when the page asks or sends: a channel itself never changes.
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const clock = useCallback(() => (latest.current.now ?? (() => performance.now()))(), []);
  const settle = useCallback((next: PanelWatch) => {
    watch.current = next;
    if (next.stopped) {
      send.current = undefined;
      setStopped(true);
    }
  }, []);
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
          if (asked.ok) latest.current.onAction(message.name, message.value);
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
      setStopped(false);
      setGeneration((count) => count + 1);
      setChannel(open());
    },
  };
}
