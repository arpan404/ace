import {
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  BrowserIcon,
  HandIcon,
  LockSimpleIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { usePanelServices } from "../services.ts";
import { useVersion } from "../store.ts";
import type { BrowserView, PreviewSource, ScreenFrame } from "../sources.ts";

function usePreview(source: PreviewSource, threadId: string) {
  useVersion(source);
  return {
    view: source.view(threadId),
    frame: source.frame(threadId),
    servers: source.servers(threadId),
  };
}

/**
 * Preview tab: the browser an agent is driving (live frames, take control, hand back), or the
 * dev server the preview gateway found for this thread.
 */
export function PreviewTab(props: { threadId: string }) {
  const { preview } = usePanelServices();
  const { view, frame, servers } = usePreview(preview, props.threadId);
  if (view && !view.closed && frame)
    return <LiveBrowser source={preview} threadId={props.threadId} view={view} frame={frame} />;
  if (servers.length) return <DevServer servers={servers} />;
  return (
    <EmptyState
      icon={BrowserIcon}
      title="Nothing to preview"
      description="When an agent opens a browser or starts a dev server, its page shows here."
    />
  );
}

function LiveBrowser(props: {
  source: PreviewSource;
  threadId: string;
  view: BrowserView;
  frame: ScreenFrame;
}) {
  const [full, setFull] = useState(false);
  const control = useControl(props.source, props.threadId, props.view);
  const frame = (
    <BrowserFrame url={props.view.url}>
      <LiveFrame {...props} interactive={props.view.controller === "human"} />
      <div className="glass absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full p-1">
        <ControlButton control={control} view={props.view} />
      </div>
    </BrowserFrame>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 px-3.5 pt-3.5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ControlStatus view={props.view} />
        <span className="flex-1" />
        <Button size="sm" onClick={() => setFull(true)}>
          <ArrowsOutSimpleIcon aria-hidden size={14} />
          Open full view
        </Button>
      </div>
      {control.error && (
        <p role="alert" className="text-xs text-status-failed">
          {control.error}
        </p>
      )}
      <div className="min-h-0 flex-1">{frame}</div>
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] max-w-none flex-col gap-3 bg-background p-6">
          <DialogTitle className="sr-only">Live view of {props.view.url}</DialogTitle>
          <div className="min-h-0 flex-1">
            <BrowserFrame url={props.view.url}>
              <LiveFrame {...props} interactive={props.view.controller === "human"} />
            </BrowserFrame>
          </div>
          <div className="glass mx-auto flex items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-ui">
            <ControlStatus view={props.view} />
            <ControlButton control={control} view={props.view} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function useControl(source: PreviewSource, threadId: string, view: BrowserView) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const change =
      view.controller === "human" ? source.handback(threadId) : source.takeover(threadId);
    change
      .catch(() =>
        setError(
          view.controller === "human" ? "Couldn't hand back control." : "Couldn't take control.",
        ),
      )
      .finally(() => setBusy(false));
  };
  useHotkey(keymap.takeControl.keys, toggle);
  return { toggle, busy, error };
}

function ControlStatus(props: { view: BrowserView }) {
  if (props.view.controller === "human")
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Dot tone="needs-you" />
        <span className="truncate">
          <b className="font-medium text-foreground">You</b> have control · the agent is paused
        </span>
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Spinner className="text-status-working" />
      <span className="truncate">
        <b className="font-medium text-foreground">{props.view.owner ?? "An agent"}</b> is
        controlling the browser
      </span>
    </span>
  );
}

function ControlButton(props: { control: ReturnType<typeof useControl>; view: BrowserView }) {
  const human = props.view.controller === "human";
  return (
    <Button
      size="sm"
      variant={human ? "secondary" : "primary"}
      disabled={props.control.busy}
      onClick={props.control.toggle}
      className="rounded-full"
    >
      {!human && <HandIcon aria-hidden size={14} />}
      {human ? "Hand back" : "Take control"}
      <Kbd
        aria-hidden
        keys={keymap.takeControl.keys}
        className="ml-0.5 bg-[rgb(255_255_255/0.18)] text-current"
      />
    </Button>
  );
}

/** Light browser chrome around a page: traffic lights and the URL. Always light, like a page. */
function BrowserFrame(props: { url: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl bg-white text-[#1C1C22] shadow-[0_0_0_0.5px_rgb(0_0_0/0.2),0_20px_60px_rgb(0_0_0/0.3)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/[0.08] bg-[#F2F2F4] px-3">
        <span aria-hidden className="flex gap-1.5">
          {[0, 1, 2].map((dot) => (
            <i key={dot} className="size-2.5 rounded-full bg-[#D6D6DA]" />
          ))}
        </span>
        <span className="mx-auto flex h-[26px] max-w-[460px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[7px] bg-white px-2 text-[12px] text-[#55555E] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]">
          <LockSimpleIcon aria-hidden size={12} />
          <span className="truncate">{props.url}</span>
        </span>
        <span className="w-[52px]" />
      </div>
      <div className="relative min-h-0 flex-1">{props.children}</div>
    </div>
  );
}

function LiveFrame(props: {
  source: PreviewSource;
  threadId: string;
  view: BrowserView;
  frame: ScreenFrame;
  interactive: boolean;
}) {
  const { frame } = props;
  const point = (event: MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = box.width ? frame.width / box.width : 1;
    return {
      x: Math.round((event.clientX - box.left) * scale),
      y: Math.round((event.clientY - box.top) * scale),
    };
  };
  const send = (event: "mousePressed" | "mouseReleased") => (mouse: MouseEvent<HTMLElement>) =>
    props.source.input(props.threadId, { kind: "mouse", event, ...point(mouse) });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    props.source.input(props.threadId, {
      kind: "key",
      event: "keyDown",
      key: event.key,
      ...(event.key.length === 1 ? { text: event.key } : {}),
    });
  };
  const image = (
    <img
      src={frame.src}
      alt={`Live view of ${props.view.url}`}
      draggable={false}
      className="absolute inset-0 size-full object-contain object-top"
    />
  );
  if (!props.interactive) return image;
  return (
    <div
      role="application"
      aria-label={`Control ${props.view.url}`}
      tabIndex={0}
      onMouseDown={send("mousePressed")}
      onMouseUp={send("mouseReleased")}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-0 cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {image}
    </div>
  );
}

const label = (server: { port: number; name?: string }) =>
  server.name ? `${server.name} · :${server.port}` : `:${server.port}`;

function DevServer(props: {
  servers: readonly { port: number; origin?: string; name?: string }[];
}) {
  const [port, setPort] = useState(props.servers[0]?.port);
  const server = props.servers.find((candidate) => candidate.port === port) ?? props.servers[0];
  if (!server) return null;
  const url = server.origin ?? `http://localhost:${server.port}`;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 px-3.5 pt-3.5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {props.servers.length > 1 ? (
          <Select
            label="Dev server"
            value={String(server.port)}
            options={props.servers.map((s) => ({ value: String(s.port), label: label(s) }))}
            onValueChange={(value) => setPort(Number(value))}
            className="h-[26px] min-w-0"
          />
        ) : (
          <span>
            Dev server <b className="font-medium text-foreground">{label(server)}</b>
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" render={<a href={url} target="_blank" rel="noreferrer" />}>
          <ArrowSquareOutIcon aria-hidden size={14} />
          Open in browser
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <BrowserFrame url={url.replace(/^https?:\/\//, "")}>
          <iframe
            title={`Preview of ${url}`}
            src={url}
            // The page is the user's own dev server on another origin, so the browser already
            // isolates it; it needs scripts and its own storage to work.
            // oxlint-disable-next-line react/iframe-missing-sandbox
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            className="absolute inset-0 size-full border-0"
          />
        </BrowserFrame>
      </div>
    </div>
  );
}
