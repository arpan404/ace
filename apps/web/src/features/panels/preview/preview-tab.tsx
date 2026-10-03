import {
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  BrowserIcon,
  LockSimpleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useThreadMeta } from "@ace/client-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { ControlToggle } from "@/components/control-toggle.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { usePanelServices } from "../services.ts";
import { useVersion } from "../store.ts";
import { useBrowserDriver } from "./use-browser-driver.ts";
import { useViewportSync } from "./use-viewport-sync.ts";
import type {
  BrowserDownload,
  BrowserView,
  PreviewServer,
  PreviewSource,
  ScreenFrame,
} from "../sources.ts";

function usePreview(source: PreviewSource, threadId: string) {
  // The source's reads change whenever its version does; React Compiler would memoize them
  // by their arguments, so this hook opts out and re-reads on every version.
  "use no memo";
  useVersion(source);
  // Follow the thread's browser and dev servers only while this tab shows them.
  useEffect(() => source.watch(threadId), [source, threadId]);
  return {
    view: source.view(threadId),
    frame: source.frame(threadId),
    servers: source.servers(threadId),
    download: source.download(),
    canForward: source.canForward(),
  };
}

/**
 * Preview tab: the browser an agent is driving (live frames, take control, hand back), or the
 * dev server the preview gateway found for this thread.
 */
export function PreviewTab(props: { threadId: string }) {
  const { preview } = usePanelServices();
  const { view, frame, servers, download, canForward } = usePreview(preview, props.threadId);
  if (view && !view.closed && frame)
    return <LiveBrowser source={preview} threadId={props.threadId} view={view} frame={frame} />;
  if (servers.length)
    return <DevServer source={preview} threadId={props.threadId} servers={servers} />;
  return (
    <NoPreview
      source={preview}
      threadId={props.threadId}
      download={download}
      canForward={canForward}
    />
  );
}

const downloadPhases: Record<BrowserDownload["phase"], string> = {
  downloading: "Downloading the browser",
  verifying: "Checking the download",
  extracting: "Unpacking the browser",
};

/** "Downloading the browser · 40%": the daemon fetches Chromium before its first browser. */
function downloadText(download: BrowserDownload): string {
  const phase = downloadPhases[download.phase];
  return download.phase === "downloading" && download.fraction !== undefined
    ? `${phase} · ${Math.floor(download.fraction * 100)}%`
    : `${phase}…`;
}

/** Nothing to show yet: say so, and offer to open a browser for the thread. */
function NoPreview(props: {
  source: PreviewSource;
  threadId: string;
  download: BrowserDownload | undefined;
  canForward: boolean;
}) {
  const workspaceId = useThreadMeta(props.threadId)?.workspaceId;
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle");
  const open = () => {
    if (!workspaceId) return;
    setState("opening");
    props.source.open(props.threadId, workspaceId).then(
      () => setState("idle"),
      () => setState("failed"),
    );
  };
  const download = state === "opening" ? props.download : undefined;
  if (download)
    return (
      <EmptyState
        icon={BrowserIcon}
        title="Getting the browser ready"
        description={
          <span className="flex flex-col items-center gap-3">
            <DownloadBar download={download} />
            <span>The first browser on this machine takes a few minutes.</span>
          </span>
        }
      />
    );
  return (
    <EmptyState
      icon={BrowserIcon}
      title="Nothing to preview"
      description={
        state === "failed"
          ? "The daemon couldn't open a browser for this thread."
          : "When an agent opens a browser or starts a dev server, its page shows here."
      }
      action={
        workspaceId ? (
          <div className="flex flex-col items-center gap-4">
            <Button size="sm" disabled={state === "opening"} onClick={open}>
              {state === "opening" && <Spinner />}
              Open a browser
            </Button>
            {props.canForward && <PortForm source={props.source} threadId={props.threadId} />}
          </div>
        ) : undefined
      }
    />
  );
}

/**
 * The daemon fetching Chromium: a thin bar, determinate while it knows the size, sweeping while
 * it checks and unpacks.
 */
function DownloadBar(props: { download: BrowserDownload }) {
  const { download } = props;
  const percent =
    download.phase === "downloading" && download.fraction !== undefined
      ? Math.floor(Math.min(1, Math.max(0, download.fraction)) * 100)
      : undefined;
  return (
    <span className="flex w-[220px] flex-col items-center gap-1.5">
      <span
        role="progressbar"
        aria-label={downloadPhases[download.phase]}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={downloadText(download)}
        className="relative block h-1 w-full overflow-hidden rounded-full bg-secondary"
      >
        {percent === undefined ? (
          <span className="fx-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-foreground/70" />
        ) : (
          <span
            className="absolute inset-0 origin-left rounded-full bg-foreground/70 transition-transform duration-(--dur-2) ease-smooth"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        )}
      </span>
      <span className="text-xs text-subtle-foreground tabular-nums">{downloadText(download)}</span>
    </span>
  );
}

/** "Or preview port [3000]": a dev server already running in the checkout, through the gateway. */
function PortForm(props: { source: PreviewSource; threadId: string }) {
  const [port, setPort] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const parsed = Number(port);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
  return (
    <form
      aria-label="Preview a dev server"
      className="flex flex-col items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || sending) return;
        setSending(true);
        setError(undefined);
        props.source.forward(props.threadId, parsed).then(
          () => setSending(false),
          () => {
            setSending(false);
            setError(`The daemon couldn't preview port ${parsed}.`);
          },
        );
      }}
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        or preview port
        <Input
          aria-label="Dev server port"
          inputMode="numeric"
          placeholder="3000"
          value={port}
          onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
          className="h-7 w-[72px] text-center font-mono"
        />
        <Button type="submit" size="sm" variant="ghost" disabled={!valid || sending}>
          Preview
        </Button>
      </span>
      {error && (
        <span role="alert" className="text-sm text-status-failed">
          {error}
        </span>
      )}
    </form>
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
      <LiveFrame {...props} interactive={props.view.controller === "human"} active={!full} />
    </BrowserFrame>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 px-3.5 pt-3.5 pb-3">
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
      {/* Under the frame, in flow, so it never covers the page. */}
      <div className="flex shrink-0 justify-center">
        <ControlButton control={control} view={props.view} />
      </div>
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent className="flex h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] max-w-none flex-col gap-3 bg-background p-6">
          <DialogTitle className="sr-only">Live view of {props.view.url}</DialogTitle>
          <div className="min-h-0 flex-1">
            <BrowserFrame url={props.view.url}>
              <LiveFrame {...props} interactive={props.view.controller === "human"} active />
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
  const driver = useBrowserDriver(props.view.threadId);
  if (props.view.status === "paused" || props.view.status === "recovering")
    return (
      <span className="flex min-w-0 items-center gap-2">
        {props.view.status === "recovering" ? <Spinner /> : <Dot tone="needs-you" />}
        <span className="truncate">
          {props.view.status === "recovering"
            ? "Reconnecting the browser"
            : "The browser is paused"}
          {props.view.reason && ` · ${props.view.reason}`}
        </span>
      </span>
    );
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
        <b className="font-medium text-foreground">{driver ?? "An agent"}</b> is controlling the
        browser
      </span>
    </span>
  );
}

function ControlButton(props: { control: ReturnType<typeof useControl>; view: BrowserView }) {
  return (
    <ControlToggle
      inControl={props.view.controller === "human"}
      disabled={props.control.busy}
      onToggle={props.control.toggle}
    />
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
  /** This pane sets the remote viewport (the full view takes over while it is open). */
  active: boolean;
}) {
  const { frame } = props;
  const pane = useRef<HTMLDivElement>(null);
  useViewportSync(props.source, props.threadId, pane, props.active);
  // Pointer positions map back to page pixels through the picture's rendered box, which is
  // 1:1 once the viewport follows the pane and scaled to fit when the backend can't resize.
  const point = (event: MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.querySelector("img")?.getBoundingClientRect();
    const scale = box?.width ? frame.width / box.width : 1;
    return {
      x: Math.round((event.clientX - (box?.left ?? 0)) * scale),
      y: Math.round((event.clientY - (box?.top ?? 0)) * scale),
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
      width={frame.width}
      height={frame.height}
      className="block h-auto max-h-full w-auto max-w-full object-contain"
    />
  );
  // The page sits top-left like a browser's; any space a frame doesn't cover (scaled to fit,
  // or the moment between a resize and its next frame) is letterboxed in --muted.
  const className = "absolute inset-0 flex items-start justify-start overflow-hidden bg-muted";
  return props.interactive ? (
    <div
      ref={pane}
      role="application"
      aria-label={`Control ${props.view.url}`}
      tabIndex={0}
      onMouseDown={send("mousePressed")}
      onMouseUp={send("mouseReleased")}
      onKeyDown={onKeyDown}
      className={cn(
        className,
        "cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      {image}
    </div>
  ) : (
    <div ref={pane} className={className}>
      {image}
    </div>
  );
}

const label = (server: PreviewServer) =>
  server.name ? `${server.name} · :${server.port}` : `:${server.port}`;

function DevServer(props: {
  source: PreviewSource;
  threadId: string;
  servers: readonly PreviewServer[];
}) {
  const [port, setPort] = useState(props.servers[0]?.port);
  const server = props.servers.find((candidate) => candidate.port === port) ?? props.servers[0];
  if (!server) return null;
  const url = server.origin ?? `http://localhost:${server.port}`;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 px-3.5 pt-3.5 pb-3">
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
        {server.source === "listener" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void props.source.unforward(props.threadId, server.port).catch(() => {})}
          >
            Stop preview
          </Button>
        )}
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
