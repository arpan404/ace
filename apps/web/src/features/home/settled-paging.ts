import type { SidebarReader } from "@ace/client";
import { useClient, useSidebar, useSidebarStore } from "@ace/client-react";
import { useState } from "react";
import { usePrimaryMachine } from "@/lib/machines.ts";

/** Home's own window still holds older settled threads back (the archive pages its own). */
const olderLeft = (reader: SidebarReader) =>
  reader.window === reader.homeWindow && reader.window?.before !== undefined;

interface Request {
  /** What the request belongs to: the project and device filters. */
  key: string;
  loading: boolean;
  error: boolean;
  /** The last page brought nothing new: scrolling stops asking until the filters change. */
  stalled: boolean;
}

/**
 * The Settled tab's paging: every loaded settled thread shows, and scrolling near the end asks
 * the daemon for the next page (`more`) while it still holds older ones back. A failed page
 * shows a retry at the end; a page that brings nothing new stops the asking, so a daemon that
 * keeps saying older threads remain can't loop; changing the project or device filter starts
 * over. Another machine's threads all arrive at once, so they never page.
 */
export function useSettledPaging(project: string | null, device?: string) {
  const client = useClient();
  const own = usePrimaryMachine().id;
  const key = JSON.stringify([project, device]);
  const store = useSidebarStore();
  const left = useSidebar(["window", "homeWindow"], olderLeft) ?? false;
  const fresh: Request = { key, loading: false, error: false, stalled: false };
  const [held, setRequest] = useState<Request>(fresh);
  const request = held.key === key ? held : fresh;
  const hasMore = left && !request.stalled && (!device || device === own);
  const update = (patch: Partial<Request>) =>
    setRequest((current) => ({ ...(current.key === key ? current : request), ...patch, key }));
  const more = async () => {
    if (request.loading || !hasMore) return;
    update({ loading: true, error: false });
    const before = store?.ids.length ?? 0;
    try {
      await client.threadsMore();
      update({ loading: false, stalled: (store?.ids.length ?? 0) <= before });
    } catch {
      update({ loading: false, error: true });
    }
  };
  return { hasMore, loading: request.loading, error: request.error, more };
}
