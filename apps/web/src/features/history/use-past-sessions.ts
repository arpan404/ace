import { useClient } from "@ace/client-react";
import {
  WorkspaceId,
  type HistorySession,
  type HistoryListRequest,
  type HistoryScanStatus,
} from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { Project } from "@/lib/projects.ts";

export function usePastSessions(
  project: Project,
  page: Pick<HistoryListRequest, "limit"> & Partial<Pick<HistoryListRequest, "before" | "search">>,
) {
  const client = useClient();
  const [scan, setScan] = useState<HistoryScanStatus>();
  const query = useDaemonQuery({
    queryKey: ["past-sessions", project.path, page],
    staleTime: 30_000,
    read: (api, signal) =>
      api.request(
        { type: "history.list", cwd: project.path, openableOnly: true, ...page },
        { signal },
      ),
  });
  const { refetch } = query;
  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type === "history.scan.updated") {
          setScan(message.scan);
          if (message.scan.state === "ready") void refetch({ cancelRefetch: false });
        }
      }),
    [client, refetch],
  );
  const state = (scan ?? query.data?.scan)?.state;
  const scanLabel =
    state === "retrying"
      ? "Past sessions will be back shortly. Retrying…"
      : state === "scanning"
        ? "Looking for saved conversations…"
        : undefined;
  return { ...query, scanLabel, refreshing: scanLabel !== undefined };
}

export function useOpenSession(project: Project) {
  const client = useClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const open = async (session: HistorySession, action: "import" | "continue") => {
    setBusy(true);
    setError(undefined);
    try {
      const imported = await client.request({
        type: "history.import",
        sourceId: session.id,
        workspaceId: WorkspaceId.parse(project.id),
      });
      if (imported.status !== "imported") {
        setError(
          "This saved conversation couldn't be imported. Open it in its original app, then try again.",
        );
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
            "The conversation was imported, but couldn't continue. Use Import to read it, or check the provider in Settings.",
          );
          return;
        }
      }
      await navigate({ to: "/t/$threadId", params: { threadId: imported.threadId } });
    } catch {
      setError("The saved conversation couldn't be opened. Refresh past sessions and try again.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, open };
}
