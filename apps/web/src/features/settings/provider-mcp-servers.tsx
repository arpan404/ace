import { useClient, useConnectionState } from "@ace/client-react";
import type { McpSources, ProviderKind } from "@ace/protocol";
import { ArrowsClockwiseIcon, PlusIcon, PowerIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { providerMcpSource } from "./provider-mcp-source.ts";

const AddMcpServer = lazy(() => import("./add-mcp-server.tsx"));

/** The providers whose sessions hand ace their MCP controls. */
const managed = new Set<ProviderKind>(["claude", "codex", "opencode"]);

type Status = McpSources["servers"][number]["status"];
/**
 * One plain word per state, in the same muted text: a server waiting for its own sign-in is the
 * server's business, never a problem with the provider.
 */
const words: Record<Status, string | undefined> = {
  connected: "Connected",
  connecting: "Starting…",
  disabled: "Off",
  needs_auth: "Not signed in",
  failed: "Couldn't start",
  unknown: undefined,
};

export function ProviderMcpServers(props: { provider: ProviderKind; name: string }) {
  if (!managed.has(props.provider)) return null;
  return <McpServerList provider={props.provider} name={props.name} />;
}

/**
 * The provider's own MCP servers as its latest live session reports them: name, a status word,
 * Reconnect and Turn off / Turn on, then Add MCP server. Read once when the page opens (and
 * again after a reconnect to ace), never polled.
 */
function McpServerList(props: { provider: ProviderKind; name: string }) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const source = useMemo(() => providerMcpSource(client, props.provider), [client, props.provider]);
  const [data, setData] = useState<McpSources>();
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const lifetime = new AbortController();
    source.read(lifetime.signal).then(
      (value) => {
        if (lifetime.signal.aborted) return;
        setData(value);
        setFailed(false);
      },
      () => {
        if (!lifetime.signal.aborted) setFailed(true);
      },
    );
    return () => lifetime.abort();
  }, [source, ready]);
  const retry = () => {
    setFailed(false);
    source.read().then(setData, () => setFailed(true));
  };
  const control = async (
    type: "mcp.provider.reconnect" | "mcp.provider.enable" | "mcp.provider.disable",
    name: string,
    verb: string,
  ) => {
    setBusy(true);
    setNote("");
    try {
      await source.control(type, name);
      setData(await source.read());
    } catch {
      setNote(`Couldn't ${verb} ${name}. Try again, or check it in ${props.name}.`);
    } finally {
      setBusy(false);
    }
  };
  const servers = data?.servers ?? [];
  return (
    <SettingSection
      label="MCP servers"
      note={
        data && !data.live
          ? `${props.name}'s MCP servers show here while one of its threads is running.`
          : data?.appliesNextTurn
            ? "Changes apply on the next turn."
            : undefined
      }
    >
      {failed && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          Couldn't read the MCP servers.
          <Button size="sm" variant="ghost" onClick={retry}>
            Try again
          </Button>
        </p>
      )}
      <ul aria-label={`${props.name} MCP servers`} className="divide-y">
        {servers.map((server) => {
          const word = words[server.status];
          const off = server.status === "disabled";
          return (
            <li key={server.name} className="flex min-h-9 items-center gap-2 py-1">
              <span className="min-w-0 flex-1 truncate font-medium">{server.name}</span>
              {word && <span className="shrink-0 text-sm text-muted-foreground">{word}</span>}
              {!off && (
                <IconButton
                  icon={ArrowsClockwiseIcon}
                  label={`Reconnect ${server.name}`}
                  tip="Reconnect"
                  size="sm"
                  disabled={busy}
                  onClick={() => void control("mcp.provider.reconnect", server.name, "reconnect")}
                />
              )}
              <IconButton
                icon={PowerIcon}
                label={`${off ? "Turn on" : "Turn off"} ${server.name}`}
                tip={off ? "Turn on" : "Turn off"}
                size="sm"
                disabled={busy}
                onClick={() =>
                  void (off
                    ? control("mcp.provider.enable", server.name, "turn on")
                    : control("mcp.provider.disable", server.name, "turn off"))
                }
              />
            </li>
          );
        })}
        {data?.canAdd && (
          <li>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex min-h-9 w-full items-center gap-2 py-1 text-left text-muted-foreground focus-ring hover:text-foreground"
            >
              <PlusIcon aria-hidden size={14} />
              <span className="font-medium">Add MCP server</span>
            </button>
          </li>
        )}
      </ul>
      {note && (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {note}
        </p>
      )}
      {adding && (
        <Suspense fallback={null}>
          <AddMcpServer
            source={source}
            provider={props.provider}
            onClose={() => setAdding(false)}
            onAdded={async () => {
              setData(await source.read());
            }}
          />
        </Suspense>
      )}
    </SettingSection>
  );
}
