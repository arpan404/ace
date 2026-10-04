import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  BrowserIcon,
  StopIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import type { PreviewServer, PreviewSource } from "../sources.ts";

function useServers(source: PreviewSource, threadId: string) {
  // The source's reads change whenever its version does; React Compiler would memoize them
  // by their arguments, so this hook opts out and re-reads on every version.
  "use no memo";
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  // Follow the thread's dev servers only while this tab shows them.
  useEffect(() => source.watch(threadId), [source, threadId]);
  return { servers: source.servers(threadId), canForward: source.canForward() };
}

/**
 * Preview: a dev server of the thread, through the daemon's preview gateway, drawn edge to edge
 * on the panel. The browser an agent drives (with its address bar and control lease) is the
 * Browser tool; Preview binds to a port.
 */
export function PreviewTab(props: { threadId: string }) {
  const { preview } = usePanelServices();
  const { servers, canForward } = useServers(preview, props.threadId);
  if (servers.length)
    return <DevServer source={preview} threadId={props.threadId} servers={servers} />;
  return <NoPreview source={preview} threadId={props.threadId} canForward={canForward} />;
}

/** Nothing to preview yet: say so, offer a port, and point at the Browser for any page. */
function NoPreview(props: { source: PreviewSource; threadId: string; canForward: boolean }) {
  const actions = useWorkspaceActions(props.threadId);
  return (
    <EmptyState
      icon={BrowserIcon}
      title="No dev server yet"
      description={
        props.canForward
          ? "When this thread starts a dev server, its page shows here. Preview one that's already running by its port."
          : "This daemon runs no preview gateway, so dev servers can't be previewed here. Open them in the Browser instead."
      }
      action={
        <div className="flex flex-col items-center gap-4">
          {props.canForward && <PortForm source={props.source} threadId={props.threadId} />}
          <Button size="sm" variant="ghost" onClick={() => actions.open({ kind: "browser" })}>
            Open the Browser
          </Button>
        </div>
      }
    />
  );
}

/** "Preview port [3000]": a dev server already running in the checkout, through the gateway. */
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
        Preview port
        <Input
          aria-label="Dev server port"
          inputMode="numeric"
          placeholder="3000"
          value={port}
          onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
          className="h-7 w-[72px] text-center font-mono"
        />
        <Button type="submit" size="sm" disabled={!valid || sending}>
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

const label = (server: PreviewServer) =>
  server.name ? `${server.name} · :${server.port}` : `:${server.port}`;

/** One dev server, with its address, Reload, Stop preview and Open in your browser above it. */
function DevServer(props: {
  source: PreviewSource;
  threadId: string;
  servers: readonly PreviewServer[];
}) {
  const [port, setPort] = useState(props.servers[0]?.port);
  const [reloads, setReloads] = useState(0);
  const server = props.servers.find((candidate) => candidate.port === port) ?? props.servers[0];
  if (!server) return null;
  const url = server.origin ?? `http://localhost:${server.port}`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <IconButton
          icon={ArrowClockwiseIcon}
          label="Reload"
          className="size-7 rounded-[7px]"
          onClick={() => setReloads((count) => count + 1)}
        />
        {props.servers.length > 1 ? (
          <Select
            label="Dev server"
            value={String(server.port)}
            options={props.servers.map((each) => ({
              value: String(each.port),
              label: label(each),
            }))}
            onValueChange={(value) => setPort(Number(value))}
            className="h-7 min-w-0 flex-1"
          />
        ) : (
          <span className="flex h-8 min-w-0 flex-1 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)] px-3 text-ui text-foreground">
            <span className="truncate">
              {url.replace(/^https?:\/\//, "")}
              {server.name && <span className="text-subtle-foreground"> · {server.name}</span>}
            </span>
          </span>
        )}
        {server.source === "listener" && (
          <IconButton
            icon={StopIcon}
            label="Stop previewing · the server keeps running"
            className="size-7 rounded-[7px]"
            onClick={() => void props.source.unforward(props.threadId, server.port).catch(() => {})}
          />
        )}
        <IconButton
          icon={ArrowSquareOutIcon}
          label="Open in your browser"
          className="size-7 rounded-[7px]"
          onClick={() => void openExternal(url).catch(() => undefined)}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          key={reloads}
          title={`Preview of ${url}`}
          src={url}
          // The page is the user's own dev server on another origin, so the browser already
          // isolates it; it needs scripts and its own storage to work.
          // oxlint-disable-next-line react/iframe-missing-sandbox
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          className="absolute inset-0 size-full border-0 bg-background"
        />
      </div>
    </div>
  );
}
