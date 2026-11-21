import {
  mcpAppBusy,
  mcpAppContextChanged,
  mcpAppInitialized,
  mcpAppLinkAnswer,
  mcpAppLinkConfirm,
  mcpAppStep,
  mcpAppToolInput,
  mcpAppToolResult,
  panelConfirmPressed,
  panelFaulted,
  panelMayAct,
  panelPingMs,
  panelPonged,
  panelTick,
  panelWatch,
  readMcpAppMessage,
  type HtmlTheme,
  type McpAppDelivery,
  type McpAppFacts,
  type PanelConfirm,
  type PanelWatch,
} from "@ace/html";
import type { McpAppHostMessage, PanelHostMessage } from "@ace/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelChannel } from "@/features/visualization/index.ts";
import type { PanelConfirmLine } from "./use-panel-host.ts";

/*
 * The host's side of one MCP app's page shown as a panel (ADR 0202 §4): it answers the page's
 * `ui/initialize` with the person's theme and the panel's place, then gives it its tool's input
 * and result (again whenever a new result comes), and theme changes after. What the page asks
 * goes through `@ace/html`'s MCP Apps mapping: its tool calls, messages and context go to the bot
 * as the page's (`onDeliver`), within the panel budget; a link waits on ace's own line outside the
 * page and opens only on the person's real press; anything else is refused to the page. A page
 * that throws or stalls three times is stopped, as a package panel is.
 */

const inputTrusted = (event: Event) => event.isTrusted;

/** A panel state's tool input and result: Spade lists `{input, result}`, a live update adds `app`. */
function parts(state: unknown): { input: unknown; result: unknown } {
  if (!state || typeof state !== "object") return { input: undefined, result: undefined };
  return { input: Reflect.get(state, "input"), result: Reflect.get(state, "result") };
}

export function useMcpAppHost(input: {
  facts: McpAppFacts;
  state: unknown;
  theme: HtmlTheme;
  size: { width: number; height: number };
  platform: "web" | "desktop";
  /** A request the page sent: the page's, never the person's. */
  onDeliver(action: McpAppDelivery, value: unknown): void;
  /** A link the person confirmed on ace's own line. */
  onOpenLink(url: string): void;
  now?: () => number;
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
  const pending = useRef<{ line: PanelConfirm; id: string | number } | undefined>(undefined);
  const send = useRef<((message: PanelHostMessage | McpAppHostMessage) => void) | undefined>(
    undefined,
  );
  // The page said it is ready: from then on it gets the tool's input and results.
  const initialized = useRef(false);
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const clock = useCallback(() => (latest.current.now ?? (() => performance.now()))(), []);
  const place = useCallback(
    () => ({
      theme: latest.current.theme,
      size: latest.current.size,
      platform: latest.current.platform,
    }),
    [],
  );
  const ask = useCallback((next: { line: PanelConfirm; id: string | number } | undefined) => {
    pending.current = next;
    setAsking(next?.line);
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
  const reply = (answer: McpAppHostMessage) => send.current?.(answer);
  const open = (): PanelChannel => ({
    mcpApp: true,
    onReady(sender) {
      send.current = sender;
      initialized.current = false;
    },
    onMessage(raw) {
      if (watch.current.stopped) return;
      const message = readMcpAppMessage(raw);
      if (!message) return;
      const step = mcpAppStep(message, latest.current.facts);
      switch (step.kind) {
        case "fault":
          return settle(panelFaulted(watch.current));
        case "pong":
          return settle(panelPonged(watch.current, step.n));
        case "answer":
          return reply(step.message);
        case "initialize":
          return reply(mcpAppInitialized(step.id, place()));
        case "initialized": {
          initialized.current = true;
          const { input: args, result } = parts(latest.current.state);
          reply(mcpAppToolInput(args));
          if (result !== undefined) reply(mcpAppToolResult(result));
          return;
        }
        case "deliver": {
          const asked = panelMayAct(watch.current, clock());
          settle(asked.watch);
          if (!asked.ok) return reply(mcpAppBusy(step.id));
          latest.current.onDeliver(step.action, step.value);
          return reply(step.answer);
        }
        case "open-link":
          // One line at a time: a page can't swap what the person is about to confirm.
          if (pending.current) return reply(mcpAppLinkAnswer(step.id, false));
          return ask({
            line: mcpAppLinkConfirm(latest.current.facts.title, step.url, clock()),
            id: step.id,
          });
        case "ignore":
          return;
      }
    },
  });
  const [channel, setChannel] = useState(open);
  // A new result for the page's tool: it gets it, once it is ready.
  const result = parts(input.state).result;
  useEffect(() => {
    if (initialized.current && result !== undefined) send.current?.(mcpAppToolResult(result));
  }, [result]);
  const theme = input.theme;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (initialized.current) send.current?.(mcpAppContextChanged({ ...place(), theme }));
  }, [theme, place]);
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
      initialized.current = false;
      ask(undefined);
      setStopped(false);
      setGeneration((count) => count + 1);
      setChannel(open());
    },
    confirm: asking && {
      words: asking.words,
      press(event) {
        const waiting = pending.current;
        if (!waiting) return;
        const trusted = (latest.current.trusted ?? inputTrusted)(event);
        if (!panelConfirmPressed({ trusted, at: clock() }, waiting.line)) return;
        ask(undefined);
        latest.current.onOpenLink(String(waiting.line.value));
        send.current?.(mcpAppLinkAnswer(waiting.id, true));
      },
      cancel() {
        const waiting = pending.current;
        ask(undefined);
        if (waiting) send.current?.(mcpAppLinkAnswer(waiting.id, false));
      },
    },
  };
}
