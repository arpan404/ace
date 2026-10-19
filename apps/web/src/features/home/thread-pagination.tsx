import { useClient, useSidebar } from "@ace/client-react";
import type { SidebarReader } from "@ace/client";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useOrganizerState } from "@/features/organize/index.ts";

const readWindow = (reader: SidebarReader) => reader.window;

/** Keep the shared list subscription on the project filter and the screen (Home or the archive). */
export function useThreadsWindowSync(): string {
  const client = useClient();
  const { project } = useOrganizerState();
  const archived = useRouterState({ select: (state) => state.location.pathname === "/archived" });
  useEffect(() => {
    void client.threadsWindow({
      ...(project ? { project } : {}),
      ...(archived ? { archived: true } : {}),
    });
  }, [client, project, archived]);
  return `${project ?? ""}:${archived}`;
}

/** The archive's foot: fetch older archived threads on demand. Home pages inside its list. */
export function ThreadPagination() {
  const client = useClient();
  const key = useThreadsWindowSync();
  const window = useSidebar(["window"], readWindow);
  const [request, setRequest] = useState<{ key: string; loading: boolean; error: boolean }>();
  const loading = request?.key === key && request.loading;
  const error = request?.key === key && request.error;
  if (!window?.before) return null;
  const more = async () => {
    if (loading) return;
    setRequest({ key, loading: true, error: false });
    try {
      await client.threadsMore();
      setRequest((current) =>
        current?.key === key ? { key, loading: false, error: false } : current,
      );
    } catch {
      setRequest((current) =>
        current?.key === key ? { key, loading: false, error: true } : current,
      );
    }
  };
  return (
    <div className="shrink-0 px-2 py-2">
      <button
        type="button"
        disabled={loading}
        onClick={() => void more()}
        className="focus-ring w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
      >
        {loading ? "Loading…" : error ? "Retry loading more" : "Show more"}
      </button>
      {error && (
        <p role="status" className="mt-1 text-center text-xs text-muted-foreground">
          Couldn’t load older threads.
        </p>
      )}
    </div>
  );
}
