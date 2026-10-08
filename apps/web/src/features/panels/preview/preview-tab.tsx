import { BrowserIcon, BrowsersIcon, StopIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import type { PreviewServer, PreviewSource } from "../sources.ts";
import { AddressBar } from "../browser/address-bar.tsx";
import { setLoading } from "../browser/loading.ts";
import { PageNav, PageToolbar, toolbarButton } from "../browser/page-toolbar.tsx";
import { noHistory, type FramePhase } from "./dev-server-frame.tsx";
import { portLabel, portTab } from "./port.ts";
import { forwardFailure } from "./preview-errors.ts";
import { OpenPreviewOutside, PreviewFrame, previewUrl } from "./preview-frame.tsx";

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
export function PreviewTab(props: { threadId: string; tabKey: string }) {
  const { preview } = usePanelServices();
  const { servers, canForward } = useServers(preview, props.threadId);
  // The tab names what it shows ("web · :5173"), and "Preview" while there is nothing yet.
  const actions = useWorkspaceActions(props.threadId);
  const [shown, setShown] = useState<PreviewServer>();
  const title = servers.length && shown ? portLabel(shown) : "Preview";
  useEffect(() => {
    actions.update(props.tabKey, { title });
  }, [actions, props.tabKey, title]);
  if (servers.length)
    return (
      <DevServer
        source={preview}
        threadId={props.threadId}
        tabKey={props.tabKey}
        servers={servers}
        onShown={setShown}
      />
    );
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
          : "ace on this machine runs no preview gateway, so dev servers can't be previewed here. Open them in the Browser instead."
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
          (failure: unknown) => {
            setSending(false);
            setError(forwardFailure(failure, parsed));
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

/**
 * One dev server under the same toolbar as a browser page: its address (read-only), Reload,
 * and its actions (another server, its own tab, Stop preview, Open in your browser).
 */
function DevServer(props: {
  source: PreviewSource;
  threadId: string;
  tabKey: string;
  servers: readonly PreviewServer[];
  onShown(server: PreviewServer | undefined): void;
}) {
  const [port, setPort] = useState(props.servers[0]?.port);
  const [attempt, setAttempt] = useState(0);
  const workspace = useWorkspaceActions(props.threadId);
  const server = props.servers.find((candidate) => candidate.port === port) ?? props.servers[0];
  const url = server ? previewUrl(server) : "";
  const [phase, setPhase] = useState<FramePhase>("loading");
  const loading = !!server && phase === "loading";
  const { onShown } = props;
  useEffect(() => onShown(server), [onShown, server]);
  useEffect(() => {
    setLoading(props.threadId, props.tabKey, loading);
    return () => setLoading(props.threadId, props.tabKey, false);
  }, [props.threadId, props.tabKey, loading]);
  if (!server) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageToolbar
        nav={
          <PageNav
            back={{ reason: noHistory }}
            forward={{ reason: noHistory }}
            reload={{ onClick: () => setAttempt((count) => count + 1) }}
          />
        }
        address={<AddressBar url={url} loading={loading} readOnly />}
        actions={
          <>
            {props.servers.length > 1 && (
              <Select
                label="Dev server"
                value={String(server.port)}
                options={props.servers.map((each) => ({
                  value: String(each.port),
                  label: portLabel(each),
                }))}
                onValueChange={(value) => setPort(Number(value))}
                className="h-7 w-32"
              />
            )}
            {server.source === "listener" && (
              <IconButton
                icon={StopIcon}
                label="Stop previewing · the server keeps running"
                className={toolbarButton}
                onClick={() =>
                  void props.source.unforward(props.threadId, server.port).catch(() => {})
                }
              />
            )}
            <IconButton
              icon={BrowsersIcon}
              label="Open in its own tab"
              className={toolbarButton}
              onClick={() => workspace.open(portTab(server))}
            />
            <OpenPreviewOutside source={props.source} threadId={props.threadId} server={server} />
          </>
        }
        progress={loading ? `Loading ${url}` : undefined}
      />
      <PreviewFrame
        source={props.source}
        threadId={props.threadId}
        server={server}
        attempt={attempt}
        onPhase={setPhase}
        onRetry={() => setAttempt((count) => count + 1)}
      />
    </div>
  );
}
