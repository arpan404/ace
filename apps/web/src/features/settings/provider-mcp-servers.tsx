import { useClient, useConnectionState } from "@ace/client-react";
import type { McpSources, ProviderKind } from "@ace/protocol";
import { ArrowsClockwiseIcon, PowerIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  SettingAddRow,
  SettingList,
  SettingListItem,
  SettingNote,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { mcpServersNote, mcpServerWord, providerHasMcpServers } from "@ace/ui-core";
import { providerMcpSource } from "./provider-mcp-source.ts";

const AddMcpServer = lazy(() => import("./add-mcp-server.tsx"));

export function ProviderMcpServers(props: { provider: ProviderKind; name: string }) {
  if (!providerHasMcpServers(props.provider)) return null;
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
    <SettingSection label="MCP servers" note={data ? mcpServersNote(data, props.name) : undefined}>
      {failed && (
        <SettingNote role="status" className="flex items-center gap-2">
          Couldn't read the MCP servers.
          <Button size="sm" variant="ghost" onClick={retry}>
            Try again
          </Button>
        </SettingNote>
      )}
      <SettingList aria-label={`${props.name} MCP servers`}>
        {servers.map((server) => {
          const word = mcpServerWord(server.status);
          const off = server.status === "disabled";
          return (
            <SettingListItem key={server.name}>
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
            </SettingListItem>
          );
        })}
        {data?.canAdd && (
          <li>
            <SettingAddRow onClick={() => setAdding(true)}>Add MCP server</SettingAddRow>
          </li>
        )}
      </SettingList>
      {note && <SettingNote role="status">{note}</SettingNote>}
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
