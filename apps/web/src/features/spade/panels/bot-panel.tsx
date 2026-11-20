import { CaretLeftIcon } from "@ace/icons";
import { validateHtml } from "@ace/html";
import type { SpadePanel } from "@ace/ui-core/spade-chat";
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
import { usePanelHost, type PanelConfirmLine as PanelConfirmLineType } from "./use-panel-host.ts";

/*
 * A packaged bot's panel beside its conversation (ADR 0200 §5.2, docs/design/spade.md): the page
 * its package ships, in ace's visualization sandbox, under the panel's title with the bot's
 * accent rule. One per bot (the side place holds one), at most four live in a window, each live
 * only while it shows. What the page sends that its panel declares goes to the bot as the page's
 * input, never the person's. An action the panel declares `confirm` waits on ace's own line under
 * the page, where only the person's real press on Confirm sends it as theirs (amendment 1). A page
 * that throws or stalls three times stops, and says so.
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

export function BotPanelView(props: {
  bot: RosterBot;
  conversation: string;
  panel: SpadePanel;
  state: unknown;
  /** It takes the window, with ‹ Chat to go back. */
  covering: boolean;
  onClose(): void;
}) {
  const { bot, panel } = props;
  const client = useSpadeClient();
  const toast = useToast();
  const theme = useHtmlTheme();
  const accent = useCardAccent(bot);
  const page = usePanelPage(panel.page);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const live = useLiveFrame(`${bot.machine.key}/${bot.id}/${panel.id}`, element, livePanels);
  const size = useSize(element);
  const deliver = (name: string, value: unknown, confirmed: boolean) =>
    void sendPanelAction(client, props.conversation, panel.id, {
      key: crypto.randomUUID(),
      name,
      value,
      confirmed,
    }).catch((error: unknown) =>
      toast.error({ title: `Couldn't send that to ${bot.name}`, description: message(error) }),
    );
  const host = usePanelHost({
    title: panel.title,
    actions: panel.actions,
    confirm: panel.confirm,
    state: props.state,
    theme,
    size,
    onAction: (name, value) => deliver(name, value, false),
    onConfirmed: (name, value) => deliver(name, value, true),
  });
  // A page that wouldn't pass the sandbox's checks is never built.
  const valid = useMemo(
    () => page.data !== undefined && validateHtml(page.data).valid,
    [page.data],
  );
  const words = "text-ui text-muted-foreground";
  let body;
  if (host.stopped)
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
        {props.covering && (
          <button
            type="button"
            aria-label="Back to chat"
            onClick={props.onClose}
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
