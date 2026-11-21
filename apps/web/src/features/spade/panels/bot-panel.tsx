import { CaretLeftIcon } from "@ace/icons";
import { validateHtml } from "@ace/html";
import type { SpadeAppPage, SpadePanel } from "@ace/ui-core/spade-chat";
import { useEffect, useMemo, useState } from "react";
import { desktopVisualizations } from "@/boot/desktop-visualizations.ts";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import {
  HtmlFrame,
  LiveFrames,
  useHtmlTheme,
  useLiveFrame,
} from "@/features/visualization/index.ts";
import { accentFill, useCardAccent } from "../spade-accent.ts";
import { useSpadeClient } from "../spade-machine.tsx";
import { message } from "../spade-screen-parts.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import { sendPanelAction, usePanelPage } from "./panels-api.ts";
import { useMcpAppHost } from "./use-mcp-app-host.ts";
import { usePanelHost, type PanelConfirmLine as PanelConfirmLineType } from "./use-panel-host.ts";

/*
 * A packaged bot's panel beside its conversation (ADR 0200 §5.2, docs/design/spade.md): the page
 * its package ships, in ace's visualization sandbox, under the panel's title with the bot's
 * accent rule. One per bot (the side place holds one), at most four live in a window, each live
 * only while it shows. What the page sends that its panel declares goes to the bot as the page's
 * input, never the person's. An action the panel declares `confirm` waits on ace's own line under
 * the page, where only the person's real press on Confirm sends it as theirs (amendment 1). A page
 * that throws or stalls three times stops, and says so. An MCP app's page (ADR 0202 §4) shows the
 * same way, in the same sandbox, with MCP Apps' messages: what it asks goes to the bot as the
 * page's, and a link it asks to open waits on the same line. One that needs the network isn't
 * drawn, and says why.
 */

/** A window's live panels: the most recently shown four. */
export const livePanels = new LiveFrames(4);

const noHeight = () => {};

/** The size of `element`, kept current. */
function useSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/**
 * ace's own line under the page for an action only the person may send: what goes, in words, and
 * Cancel and Confirm. It is outside the page, which can neither draw over it nor press it.
 */
function PanelConfirmLine(props: { line: PanelConfirmLineType }) {
  const { line } = props;
  return (
    <div
      role="group"
      aria-label="Confirm the panel's action"
      className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3"
    >
      <p aria-live="polite" className="text-ui break-words text-foreground">
        {line.words}
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={line.cancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={(event) => line.press(event.nativeEvent)}>
          Confirm
        </Button>
      </div>
    </div>
  );
}

interface ViewProps {
  bot: RosterBot;
  conversation: string;
  panel: SpadePanel;
  state: unknown;
  /** It takes the window, with ‹ Chat to go back. */
  covering: boolean;
  onClose(): void;
}

export function BotPanelView(props: ViewProps) {
  return props.panel.app ? (
    <AppPanelView {...props} app={props.panel.app} />
  ) : (
    <PackagePanelView {...props} />
  );
}

/** What both hosts give the shell: the page's channel, its watchdog and ace's own line. */
type Host = ReturnType<typeof usePanelHost>;

/** Sends one action from the page, keyed so a retry lands once; a failure says so. */
function useDeliver(props: ViewProps) {
  const client = useSpadeClient();
  const toast = useToast();
  return (name: string, value: unknown, confirmed: boolean) =>
    void sendPanelAction(client, props.conversation, props.panel.id, {
      key: crypto.randomUUID(),
      name,
      value,
      confirmed,
    }).catch((error: unknown) =>
      toast.error({
        title: `Couldn't send that to ${props.bot.name}`,
        description: message(error),
      }),
    );
}

function PackagePanelView(props: ViewProps) {
  const theme = useHtmlTheme();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const size = useSize(element);
  const deliver = useDeliver(props);
  const host = usePanelHost({
    title: props.panel.title,
    actions: props.panel.actions,
    confirm: props.panel.confirm,
    state: props.state,
    theme,
    size,
    onAction: (name, value) => deliver(name, value, false),
    onConfirmed: (name, value) => deliver(name, value, true),
  });
  return <PanelShell {...props} host={host} element={element} setElement={setElement} />;
}

function AppPanelView(props: ViewProps & { app: SpadeAppPage }) {
  const theme = useHtmlTheme();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const size = useSize(element);
  const deliver = useDeliver(props);
  const host = useMcpAppHost({
    facts: { title: props.app.name, tools: props.app.tools },
    state: props.state,
    theme,
    size,
    platform: desktopVisualizations() === undefined ? "web" : "desktop",
    onDeliver: (action, value) => deliver(action, value, false),
    // The person confirmed it on ace's own line: it opens outside the app, with no opener.
    onOpenLink: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
  });
  return (
    <PanelShell
      {...props}
      host={host}
      element={element}
      setElement={setElement}
      refused={props.app.refused}
    />
  );
}

function PanelShell(
  props: ViewProps & {
    host: Host;
    element: HTMLElement | null;
    setElement(element: HTMLElement | null): void;
    /** Why the page isn't drawn (an MCP app's page that needs the network). */
    refused?: string | undefined;
  },
) {
  const { bot, panel, host, element, setElement, refused, covering, onClose } = props;
  const theme = useHtmlTheme();
  const accent = useCardAccent(bot);
  const page = usePanelPage(refused === undefined ? panel.page : undefined);
  const live = useLiveFrame(`${bot.machine.key}/${bot.id}/${panel.id}`, element, livePanels);
  // A page that wouldn't pass the sandbox's checks is never built.
  const valid = useMemo(
    () => page.data !== undefined && validateHtml(page.data).valid,
    [page.data],
  );
  const words = "text-ui text-muted-foreground";
  let body;
  if (refused !== undefined) body = <p className={cn(words, "p-4")}>{refused}</p>;
  else if (host.stopped)
    body = (
      <div role="status" className="flex flex-col items-start gap-2 p-4">
        <p className={words}>The panel stopped.</p>
        <Button size="sm" variant="ghost" onClick={host.reload}>
          Load it again
        </Button>
      </div>
    );
  else if (!panel.page || (page.data !== undefined && !valid))
    body = <p className={cn(words, "p-4")}>This panel has no page to show.</p>;
  else if (page.isError)
    body = (
      <div className="flex flex-col items-start gap-2 p-4">
        <p className={words}>The panel couldn't load.</p>
        <Button size="sm" variant="ghost" onClick={() => void page.refetch()}>
          Try again
        </Button>
      </div>
    );
  else if (page.data !== undefined && live)
    body = (
      <HtmlFrame
        key={`${panel.page}:${host.generation}`}
        html={page.data}
        mode="interactive"
        kit={undefined}
        title={panel.title}
        theme={theme}
        initialHeight={0}
        fill
        webview={desktopVisualizations() !== undefined}
        measured={undefined}
        settled
        onHeight={noHeight}
        panel={host.channel}
      />
    );
  else body = <Skeleton className="m-4 h-24" />;
  return (
    <section
      aria-label={`${bot.name}: ${panel.title}`}
      {...part("right-panel", undefined, "spade-panel")}
      style={accent}
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-2">
        {covering && (
          <button
            type="button"
            aria-label="Back to chat"
            onClick={onClose}
            className="-ml-2 flex h-8 w-fit items-center gap-1 rounded-full pr-3 pl-2 text-ui font-medium text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
          >
            <Icon icon={CaretLeftIcon} size={16} />
            Chat
          </button>
        )}
        <h2 className="truncate text-base leading-6 font-medium text-foreground">{panel.title}</h2>
        <span
          aria-hidden
          data-agent-accent=""
          className={cn("h-0.5 w-6 rounded-full", accentFill)}
        />
      </header>
      <div ref={setElement} className="relative min-h-0 flex-1">
        {body}
      </div>
      {host.confirm && <PanelConfirmLine line={host.confirm} />}
    </section>
  );
}
