import { BrowserIcon, BrowsersIcon, StopIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import type { PreviewServer, PreviewSource, PreviewSuggestion } from "../sources.ts";
import { AddressBar } from "../browser/address-bar.tsx";
import { setLoading } from "../browser/loading.ts";
import { PageNav, PageToolbar, toolbarButton } from "../browser/page-toolbar.tsx";
import type { FramePhase } from "./dev-server-frame.tsx";
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
  return {
    servers: source.servers(threadId),
    detected: source.suggestions(threadId),
    canForward: source.canForward(),
  };
}

/** A previewed server offered again among the suggestions, at the address it was shown at. */
const suggestionOf = (server: PreviewServer): PreviewSuggestion => ({
  port: server.port,
  url: previewUrl(server),
  title: server.name,
  source: server.source === "listener" ? "listener" : "terminal",
});

/**
 * Preview: a dev server of the thread, through the daemon's preview gateway, drawn edge to edge
 * on the panel. The browser an agent drives (with its address bar and control lease) is the
 * Browser tool; Preview binds to a port. A server that answers nothing isn't held open as a
 * failed page: Preview goes back to its suggestions, where picking it tries again.
 */
export function PreviewTab(props: { threadId: string; tabKey: string }) {
  const { preview } = usePanelServices();
  const { servers, detected, canForward } = useServers(preview, props.threadId);
  const [unreachable, setUnreachable] = useState<ReadonlySet<number>>(() => new Set());
  const live = servers.filter((server) => !unreachable.has(server.port));
  // The tab names what it shows ("web · :5173"), and "Preview" while there is nothing yet.
  const actions = useWorkspaceActions(props.threadId);
  const [shown, setShown] = useState<PreviewServer>();
  const title = live.length && shown ? portLabel(shown) : "Preview";
  useEffect(() => {
    actions.update(props.tabKey, { title });
  }, [actions, props.tabKey, title]);
  if (live.length)
    return (
      <DevServer
        source={preview}
        threadId={props.threadId}
        tabKey={props.tabKey}
        servers={live}
        onShown={setShown}
        onUnreachable={(port) => setUnreachable((before) => new Set(before).add(port))}
      />
    );
  const down = servers.filter((server) => unreachable.has(server.port));
  return (
    <NoPreview
      source={preview}
      threadId={props.threadId}
      canForward={canForward}
      suggested={[
        ...down.map(suggestionOf),
        ...detected.filter((each) => !down.some((server) => server.port === each.port)),
      ]}
      unreachable={down}
      onRetry={(port) =>
        setUnreachable((before) => new Set([...before].filter((each) => each !== port)))
      }
    />
  );
}

/**
 * The dev servers the daemon found running for this project, ready to preview with one click.
 * Shown above the manual port, which stays for anything it didn't find.
 */
function DetectedServers(props: {
  source: PreviewSource;
  threadId: string;
  servers: readonly PreviewSuggestion[];
  onPick(port: number): void;
}) {
  const [error, setError] = useState<string>();
  if (props.servers.length === 0) return null;
  return (
    <div className="flex w-72 max-w-full flex-col gap-1.5">
      <ul aria-label="Detected dev servers" className="flex flex-col gap-1">
        {props.servers.map((server) => (
          <li key={server.port}>
            <button
              type="button"
              onClick={() => {
                setError(undefined);
                props.onPick(server.port);
                props.source
                  .forward(props.threadId, server.port)
                  .catch((failure: unknown) => setError(forwardFailure(failure, server.port)));
              }}
              className="focus-ring flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg border border-border px-3 text-left transition-colors duration-(--motion-fast) hover:bg-fill"
            >
              {server.iconUrl ? (
                <img
                  src={server.iconUrl}
                  alt=""
                  width={16}
                  height={16}
                  className="size-4 shrink-0 rounded-xs object-contain"
                />
              ) : (
                <BrowserIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                {server.title || `localhost:${server.port}`}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                :{server.port}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <span role="alert" className="text-sm text-status-failed">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Nothing showing: the dev servers to preview (found running, or shown before and silent now),
 * a port for anything else, and the Browser for any page.
 */
function NoPreview(props: {
  source: PreviewSource;
  threadId: string;
  canForward: boolean;
  suggested: readonly PreviewSuggestion[];
  unreachable: readonly PreviewServer[];
  onRetry(port: number): void;
}) {
  const actions = useWorkspaceActions(props.threadId);
  const suggested = props.canForward && props.suggested.length > 0;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto p-6 text-center">
      <h2 className="text-md font-medium text-foreground">
        {suggested ? "Suggested" : "No dev server"}
      </h2>
      {!props.canForward && (
        <p className="max-w-[40ch] text-ui text-muted-foreground">
          This machine can't preview dev servers. Open them in the Browser.
        </p>
      )}
      {props.unreachable.length > 0 && (
        <p role="status" className="text-ui text-muted-foreground">
          Nothing answered at{" "}
          {props.unreachable.map((server) => `localhost:${server.port}`).join(", ")}
        </p>
      )}
      {suggested && (
        <DetectedServers
          source={props.source}
          threadId={props.threadId}
          servers={props.suggested}
          onPick={props.onRetry}
        />
      )}
      {props.canForward && <PortForm source={props.source} threadId={props.threadId} />}
      <Button size="sm" variant="ghost" onClick={() => actions.open({ kind: "browser" })}>
        Open the Browser
      </Button>
    </div>
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
  onUnreachable(port: number): void;
}) {
  const toast = useToast();
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
            back={{}}
            forward={{}}
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
                label="Stop previewing"
                className={toolbarButton}
                onClick={() =>
                  void props.source.unforward(props.threadId, server.port).catch((error: unknown) =>
                    toast.error({
                      title: "Couldn’t stop previewing",
                      description: error instanceof Error ? error.message : String(error),
                    }),
                  )
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
        onUnreachable={() => props.onUnreachable(server.port)}
      />
    </div>
  );
}
