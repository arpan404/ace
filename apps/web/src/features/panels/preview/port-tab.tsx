import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  BrowserIcon,
  StopCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { cn } from "@/lib/cn.ts";
import { usePanelServices } from "../services.ts";
import type { PreviewSource } from "../sources.ts";
import { portLabel } from "./port.ts";
import { WithServices } from "../with-services.tsx";

function usePortServer(source: PreviewSource, threadId: string, port: number) {
  // The source's reads change whenever its version does; read again on every version.
  "use no memo";
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  // Follow the thread's dev servers only while this tab shows.
  useEffect(() => source.watch(threadId), [source, threadId]);
  return {
    server: source.servers(threadId).find((candidate) => candidate.port === port),
    canForward: source.canForward(),
  };
}

/** One dev server as a tab of its own: its page edge to edge under a quiet toolbar. */
export function PortTab(props: TabViewProps) {
  return (
    <WithServices>
      <PortView threadId={props.scope} port={Number(props.tab.id)} tabKey={props.tab.key} />
    </WithServices>
  );
}

function PortView(props: { threadId: string; port: number; tabKey: string }) {
  const { preview } = usePanelServices();
  const { server, canForward } = usePortServer(preview, props.threadId, props.port);
  const actions = useWorkspaceActions(props.threadId);
  const [reloads, setReloads] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"forward" | "stop">();
  const [error, setError] = useState<string>();
  const url = server?.origin ?? `http://localhost:${props.port}`;
  const title = server ? portLabel(server) : undefined;
  useEffect(() => {
    if (title) actions.update(props.tabKey, { title });
  }, [title, props.tabKey, actions]);
  const run = (kind: "forward" | "stop", work: () => Promise<void>, failure: string) => {
    setBusy(kind);
    setError(undefined);
    work().then(
      () => setBusy(undefined),
      () => {
        setBusy(undefined);
        setError(failure);
      },
    );
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b px-1.5">
        <IconButton
          icon={ArrowClockwiseIcon}
          label="Reload"
          className="size-7"
          disabled={!server}
          onClick={() => {
            setLoaded(false);
            setReloads((count) => count + 1);
          }}
        />
        <input
          aria-label="Address"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className="mx-1 h-7 min-w-0 flex-1 rounded-full bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)] px-3 font-mono text-[12px] text-muted-foreground outline-none focus-visible:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]"
        />
        <IconButton
          icon={ArrowSquareOutIcon}
          label="Open in browser"
          className="size-7"
          nativeButton={false}
          render={<a href={url} target="_blank" rel="noreferrer" />}
        />
        {server?.source === "listener" && (
          <IconButton
            icon={StopCircleIcon}
            label="Stop previewing this port"
            className="size-7"
            disabled={busy === "stop"}
            onClick={() =>
              run(
                "stop",
                () => preview.unforward(props.threadId, props.port),
                `Couldn't stop previewing port ${props.port}.`,
              )
            }
          />
        )}
        {server && !loaded && (
          <span
            role="progressbar"
            aria-label={`Loading ${url}`}
            className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
          >
            <span className="fx-indeterminate absolute inset-y-0 w-1/3 bg-foreground/50" />
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="border-b px-3 py-1.5 text-xs text-status-failed">
          {error}
        </p>
      )}
      {server ? (
        <div className="relative min-h-0 flex-1 bg-background">
          <iframe
            key={reloads}
            title={`Preview of ${url}`}
            src={url}
            onLoad={() => setLoaded(true)}
            // The page is the user's own dev server on another origin, so the browser already
            // isolates it; it needs scripts and its own storage to work.
            // oxlint-disable-next-line react/iframe-missing-sandbox
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            className={cn("absolute inset-0 size-full border-0", !loaded && "opacity-60")}
          />
        </div>
      ) : (
        <EmptyState
          icon={BrowserIcon}
          title={`Nothing is previewed on port ${props.port}`}
          description={
            canForward
              ? "The dev server stopped, or it was never forwarded for this thread. It shows here again as soon as the daemon sees it."
              : "This daemon runs no preview gateway, so it can't show ports. Open the address in your own browser instead."
          }
          action={
            canForward ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy === "forward"}
                onClick={() =>
                  run(
                    "forward",
                    () => preview.forward(props.threadId, props.port),
                    `The daemon couldn't preview port ${props.port}.`,
                  )
                }
              >
                Preview port {props.port} again
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
