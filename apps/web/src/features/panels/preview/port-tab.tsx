import { BrowserIcon, StopIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { AddressBar } from "../browser/address-bar.tsx";
import { setLoading } from "../browser/loading.ts";
import { PageNav, PageToolbar, toolbarButton } from "../browser/page-toolbar.tsx";
import { DevServerFrame, noHistory, OpenOutside, type FramePhase } from "./dev-server-frame.tsx";
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
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<"forward" | "stop">();
  const [error, setError] = useState<string>();
  const url = server?.origin ?? `http://localhost:${props.port}`;
  const title = server ? portLabel(server) : undefined;
  const [phase, setPhase] = useState<FramePhase>("loading");
  const loading = !!server && phase === "loading";
  useEffect(() => {
    if (title) actions.update(props.tabKey, { title });
  }, [title, props.tabKey, actions]);
  useEffect(() => {
    setLoading(props.threadId, props.tabKey, loading);
    return () => setLoading(props.threadId, props.tabKey, false);
  }, [props.threadId, props.tabKey, loading]);
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
      <PageToolbar
        nav={
          <PageNav
            back={{ reason: noHistory }}
            forward={{ reason: noHistory }}
            reload={{
              onClick: server ? () => setAttempt((count) => count + 1) : undefined,
              reason: server ? undefined : "the dev server isn't previewed",
            }}
          />
        }
        address={<AddressBar url={url} loading={loading} readOnly />}
        actions={
          <>
            {server?.source === "listener" && (
              <IconButton
                icon={StopIcon}
                label="Stop previewing this port"
                className={toolbarButton}
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
            <OpenOutside url={url} />
          </>
        }
        progress={loading ? `Loading ${url}` : undefined}
      />
      {error && (
        <p role="alert" className="border-b px-3 py-1.5 text-xs text-status-failed">
          {error}
        </p>
      )}
      {server ? (
        <DevServerFrame
          url={url}
          attempt={attempt}
          onPhase={setPhase}
          onRetry={() => setAttempt((count) => count + 1)}
        />
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
