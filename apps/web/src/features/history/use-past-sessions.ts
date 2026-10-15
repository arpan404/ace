import { useClient } from "@ace/client-react";
import { WorkspaceId, type HistorySession, type HistoryListRequest } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/projects.ts";

/** Reading every provider's saved sessions can take a while on a large history. */
const FIND_TIMEOUT_MS = 5 * 60_000;

export type FoundSessions =
  | { status: "idle" }
  | { status: "finding" }
  | {
      status: "found";
      sessions: HistorySession[];
      next: HistoryListRequest["before"] | null;
    }
  | { status: "failed" };

/**
 * Past sessions on request only: nothing is read until `find`, results live in this
 * component's state, and leaving tells the daemon to discard everything it read.
 */
export function useFindSessions(project: Project | undefined) {
  const client = useClient();
  // Results belong to the project they were found for; another project starts idle.
  const [state, setState] = useState<{ path: string | undefined; found: FoundSessions }>({
    path: undefined,
    found: { status: "idle" },
  });
  const found: FoundSessions = state.path === project?.path ? state.found : { status: "idle" };
  const asked = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      if (asked.current) void client.request({ type: "history.release" }).catch(() => undefined);
    },
    [client],
  );
  const load = async (input: { rescan: boolean; before?: HistoryListRequest["before"] }) => {
    if (!project) return;
    const path = project.path;
    const setFound = (next: FoundSessions) => setState({ path, found: next });
    asked.current = true;
    const current = ++generation.current;
    const previous = input.before && found.status === "found" ? found.sessions : [];
    if (!input.before) setFound({ status: "finding" });
    try {
      const page = await client.request(
        {
          type: "history.list",
          cwd: project.path,
          openableOnly: true,
          limit: 50,
          rescan: input.rescan,
          ...(input.before ? { before: input.before } : {}),
        },
        { timeoutMs: FIND_TIMEOUT_MS },
      );
      if (current !== generation.current) return;
      setFound({
        status: "found",
        sessions: [
          ...previous,
          ...page.sessions.filter((session) => session.support.status === "supported"),
        ],
        next: page.next,
      });
    } catch {
      if (current === generation.current) setFound({ status: "failed" });
    }
  };
  return {
    found,
    find: () => void load({ rescan: true }),
    more: () => {
      if (found.status === "found" && found.next) void load({ rescan: false, before: found.next });
    },
  };
}

export function useOpenSession(project: Project | undefined) {
  const client = useClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const open = async (session: HistorySession, action: "import" | "continue") => {
    if (!project) return;
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
      setError("The saved conversation couldn't be opened. Find past sessions again and retry.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, open };
}
