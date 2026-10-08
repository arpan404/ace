import {
  BellSimpleIcon,
  BrowserIcon,
  CursorClickIcon,
  DeviceMobileIcon,
  GlobeSimpleIcon,
  PlusIcon,
  TreeStructureIcon,
  ArrowsClockwiseIcon,
  PowerIcon,
} from "@phosphor-icons/react";
import { useClient } from "@ace/client-react";
import type { McpSources } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { StatusLabel } from "@/components/status-label.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { mcpSource } from "../sources/mcp-source.ts";
import { TruncatedText, RowButton, RowNote, rowIcon, SectionHead } from "./work-card-parts.tsx";

const AddMcpServer = lazy(() => import("./add-mcp-server.tsx"));
const groups = [
  { id: "thread", label: "Thread", icon: TreeStructureIcon },
  { id: "files", label: "Files", icon: TreeStructureIcon },
  { id: "thread_control", label: "Thread controls", icon: TreeStructureIcon },
  { id: "terminal", label: "Terminal", icon: TreeStructureIcon },
  { id: "forge", label: "Pull requests", icon: TreeStructureIcon },
  { id: "agents", label: "Subagents", icon: TreeStructureIcon, kind: "agents" },
  { id: "browser", label: "Browser", icon: GlobeSimpleIcon, kind: "browser" },
  {
    id: "screen",
    label: "Computer use",
    icon: CursorClickIcon,
    page: "/settings/computer-use" as const,
  },
  { id: "devices", label: "Devices", icon: DeviceMobileIcon, kind: "devices" },
  { id: "preview", label: "Preview", icon: BrowserIcon, kind: "preview" },
  {
    id: "notify",
    label: "Notifications",
    icon: BellSimpleIcon,
    page: "/settings/notifications" as const,
  },
  { id: "projects", label: "Projects", icon: TreeStructureIcon },
  { id: "automations", label: "Automations", icon: ArrowsClockwiseIcon },
];
const statuses = {
  connected: { tone: "done", label: "Connected" },
  connecting: { tone: "working", label: "Connecting" },
  disabled: { tone: "idle", label: "Disabled" },
  failed: { tone: "failed", label: "Failed" },
  unknown: { tone: "idle", label: "Unknown" },
} as const;

/** Sources reads the same enabled groups as ace MCP discovery, plus native provider status. */
export function SourcesSection(props: { thread: ThreadRef; onClose(): void }) {
  const client = useClient();
  const source = useMemo(() => mcpSource(client, props.thread.id), [client, props.thread.id]);
  const workspace = useWorkspaceActions(props.thread.id);
  const navigate = useNavigate();
  const [data, setData] = useState<McpSources>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const lifetime = new AbortController();
    let reading = false;
    const read = () => {
      if (reading || lifetime.signal.aborted) return;
      reading = true;
      void source
        .read(lifetime.signal)
        .then(
          (value) => {
            if (!lifetime.signal.aborted) {
              setData(value);
              setError("");
            }
          },
          () => {
            if (!lifetime.signal.aborted)
              setError("Could not load sources. Reopen this list to try again.");
          },
        )
        .finally(() => {
          reading = false;
        });
    };
    read();
    const stop = client.connectionState().subscribe(read);
    const timer = setInterval(read, 5_000);
    return () => {
      clearInterval(timer);
      lifetime.abort();
      stop();
    };
  }, [client, source]);
  const control = async (type: "mcp.reconnect" | "mcp.enable" | "mcp.disable", name: string) => {
    setBusy(true);
    setError("");
    try {
      await source.control(type, name);
      setData(await source.read());
    } catch {
      setError(`Could not change ${name}. Check the server in your coding agent and try again.`);
    } finally {
      setBusy(false);
    }
  };
  const enabled = groups.filter((group) => data?.groups.includes(group.id));
  const shown = all ? enabled : enabled.slice(0, 4);
  return (
    <section aria-labelledby="work-card-sources">
      <SectionHead id="work-card-sources" title="Sources">
        {data?.canAdd && (
          <IconButton
            icon={PlusIcon}
            label="Add MCP server"
            size="sm"
            className="size-7"
            onClick={() => setAdding(true)}
          />
        )}
      </SectionHead>
      {error && (
        <p role="alert" className="px-2.5 text-ui text-destructive">
          {error}
        </p>
      )}
      {!data && !error && <RowNote>Loading sources…</RowNote>}
      {data && !data.live && (
        <p className="px-2.5 text-ui text-muted-foreground">
          Send a message to see your coding agent’s MCP servers.
        </p>
      )}
      <ul aria-label="Tool sources" className="flex flex-col">
        {shown.map((group) => {
          const Icon = group.icon;
          const body = (
            <>
              <Icon aria-hidden size={16} className={rowIcon} />
              <span>{group.label}</span>
              <TruncatedText className="text-subtle-foreground">ace</TruncatedText>
            </>
          );
          return (
            <li key={group.id}>
              {group.kind || group.page ? (
                <RowButton
                  aria-label={group.label}
                  onClick={() => {
                    if (group.kind) workspace.open({ kind: group.kind });
                    else if (group.page) void navigate({ to: group.page });
                    props.onClose();
                  }}
                >
                  {body}
                </RowButton>
              ) : (
                <RowNote className="text-foreground">{body}</RowNote>
              )}
            </li>
          );
        })}
        {data?.servers.map((server) => (
          <li key={server.name} className="flex h-8 items-center gap-2.5 px-2.5 text-ui">
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            <StatusLabel {...statuses[server.status]} />
            <IconButton
              icon={ArrowsClockwiseIcon}
              label={`Reconnect ${server.name}`}
              size="sm"
              className="size-7"
              disabled={busy}
              onClick={() => void control("mcp.reconnect", server.name)}
            />
            <IconButton
              icon={PowerIcon}
              label={`${server.status === "disabled" ? "Enable" : "Disable"} ${server.name}`}
              size="sm"
              className="size-7"
              disabled={busy}
              onClick={() =>
                void control(
                  server.status === "disabled" ? "mcp.enable" : "mcp.disable",
                  server.name,
                )
              }
            />
          </li>
        ))}
      </ul>
      {enabled.length > 4 && (
        <RowButton
          aria-expanded={all}
          className="text-muted-foreground"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : "View all ace tools"}
        </RowButton>
      )}
      {data?.appliesNextTurn && (
        <p className="px-2.5 text-ui text-muted-foreground">Changes apply on the next turn.</p>
      )}
      {adding && (
        <Suspense fallback={null}>
          <AddMcpServer
            source={source}
            provider={props.thread.provider}
            onClose={() => setAdding(false)}
            onAdded={async () => {
              setData(await source.read());
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
