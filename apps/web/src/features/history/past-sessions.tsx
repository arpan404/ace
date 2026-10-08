import { useClient } from "@ace/client-react";
import { WorkspaceId, type HistorySession } from "@ace/protocol";
import { formatAgo } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useProjectDirectory, type Project } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";

const titleOf = (session: HistorySession) =>
  session.title.trim() && session.title !== session.nativeId ? session.title : "Untitled session";

export function PastSessions(props: { projectId?: string | undefined }) {
  const directory = useProjectDirectory();
  const [selected, setSelected] = useState("");
  const project =
    directory.projects.find((entry) => entry.id === (props.projectId ?? selected)) ??
    (props.projectId ? undefined : directory.projects[0]);
  return (
    <section aria-label="Past sessions" className="mt-5 min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Past sessions</h3>
        {props.projectId === undefined && project && (
          <Select
            label="Past sessions project"
            value={project.id}
            options={directory.projects.map((entry) => ({ value: entry.id, label: entry.name }))}
            onValueChange={setSelected}
          />
        )}
      </div>
      {project ? (
        <ProjectSessions key={project.id} project={project} />
      ) : (
        <p className="text-sm text-muted-foreground">Choose a project to see its past sessions.</p>
      )}
    </section>
  );
}

function ProjectSessions({ project }: { project: Project }) {
  const client = useClient();
  const navigate = useNavigate();
  const now = useNow();
  const [before, setBefore] = useState<{ lastActivity: number; id: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const query = useDaemonQuery({
    queryKey: ["past-sessions", project.path, before],
    staleTime: 30_000,
    read: (api, signal) =>
      api.request(
        { type: "history.list", cwd: project.path, limit: 20, ...(before ? { before } : {}) },
        { signal },
      ),
  });
  const { refetch } = query;
  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type === "history.scan.updated" && message.scan.state === "ready")
          void refetch({ cancelRefetch: false });
      }),
    [client, refetch],
  );
  const open = async (session: HistorySession, action: "import" | "continue") => {
    setBusy(session.id);
    setError(undefined);
    try {
      const imported = await client.request({
        type: "history.import",
        sourceId: session.id,
        workspaceId: WorkspaceId.parse(project.id),
      });
      if (imported.status !== "imported") {
        setError("This session can't be imported yet. Open it in its original app.");
        return;
      }
      if (action === "continue") {
        const continued = await client.request({
          type: "history.continue",
          threadId: imported.threadId,
          mode: "resume",
          input: [],
          delivery: "queue",
        });
        if (continued.status !== "continued") {
          setError(
            "The history was imported, but this provider couldn't continue it. Use Import to open it, or check the provider in Settings.",
          );
          return;
        }
      }
      await navigate({ to: "/t/$threadId", params: { threadId: imported.threadId } });
    } catch {
      setError(
        "The session couldn't be opened. Check that the provider is ready in Settings, then try again.",
      );
    } finally {
      setBusy(undefined);
    }
  };
  const data = query.data;
  return (
    <>
      {query.isError ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-muted-foreground">
            Past sessions couldn't be loaded. Reconnect and try again.
          </p>
          <Button variant="ghost" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading past sessions…
        </p>
      ) : (
        <>
          {data.scan?.state === "scanning" && (
            <StatusLabel tone="working" label="Looking for sessions…" />
          )}
          {data.scan?.state === "failed" && (
            <p role="alert" className="text-sm text-muted-foreground">
              Some sessions couldn't be read. Check their original app, then try again.
            </p>
          )}
          {!data.sessions.length &&
            data.scan?.state !== "scanning" &&
            data.scan?.state !== "failed" && (
              <p className="text-sm text-muted-foreground">No past sessions for this project.</p>
            )}
          <ul aria-label={`Past sessions in ${project.name}`}>
            {data.sessions.map((session) => (
              <li key={session.id} className="flex h-9 min-w-0 items-center gap-2 text-sm">
                <ProviderIconTip provider={session.provider} size={14} />
                <span className="min-w-0 flex-1 truncate" title={titleOf(session)}>
                  {titleOf(session)}
                </span>
                <time
                  className="shrink-0 text-xs text-muted-foreground"
                  dateTime={new Date(session.lastActivity).toISOString()}
                >
                  {formatAgo(session.lastActivity, now)}
                </time>
                {session.support.status === "supported" ? (
                  <>
                    <Tip label="Import the saved history into ace">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!busy}
                        onClick={() => void open(session, "import")}
                      >
                        Import
                      </Button>
                    </Tip>
                    {session.continuation?.status === "supported" ? (
                      <Tip label="Resume this session in its original provider">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!!busy}
                          onClick={() => void open(session, "continue")}
                        >
                          Continue
                        </Button>
                      </Tip>
                    ) : (
                      <Tip
                        label={
                          session.continuation?.reason ??
                          "Native continuation is unavailable. Import to read the history."
                        }
                      >
                        <span className="text-xs text-muted-foreground">Import only</span>
                      </Tip>
                    )}
                  </>
                ) : (
                  <Tip label="Open this session in its original app. Its history format isn't supported yet.">
                    <span className="text-xs text-muted-foreground">Unavailable</span>
                  </Tip>
                )}
              </li>
            ))}
          </ul>
          {data.next && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() => setBefore(data.next ?? undefined)}
            >
              Older sessions
            </Button>
          )}
          {before && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() => setBefore(undefined)}
            >
              Latest sessions
            </Button>
          )}
        </>
      )}
      {busy && <StatusLabel tone="working" label="Opening session…" />}
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
    </>
  );
}
