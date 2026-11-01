import type { SidebarReader } from "@ace/client";
import { useClient, useSidebar, useSidebarStore } from "@ace/client-react";
import { useState } from "react";
import { usePrimaryMachine } from "@/lib/machines.ts";

/** Where Home's own window's next page of settled threads starts, while it holds older ones. */
const nextPageAt = (reader: SidebarReader) =>
  reader.window === reader.homeWindow ? reader.window?.before?.at : undefined;

interface Request {
  /** What the request belongs to: the project and device filters. */
  key: string;
  loading: boolean;
  error: boolean;
  /** The last page brought nothing new: asking stops until the filters change. */
  stalled: boolean;
}

export interface SettledPaging {
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  /** Where the next page starts (its newest activity), while one is left. */
  nextAt: number | undefined;
  more(): Promise<void>;
}

/**
 * Older settled threads from the daemon, a page at a time (`more`), while it still holds some
 * back. The daemon pages every project's settled threads together, newest first, so each
 * project's settled threads and History both read from these pages. A failed page offers a retry; a page that
 * brings nothing new stops the asking, so a daemon that keeps saying older threads remain can't
 * loop; changing the project or device filter starts over. Another machine's threads all arrive
 * at once, so they never page.
 */
export function useSettledPaging(project: string | null, device?: string): SettledPaging {
  const client = useClient();
  const own = usePrimaryMachine().id;
  const key = JSON.stringify([project, device]);
  const store = useSidebarStore();
  const nextAt = useSidebar(["window", "homeWindow"], nextPageAt);
  const fresh: Request = { key, loading: false, error: false, stalled: false };
  const [held, setRequest] = useState<Request>(fresh);
  const request = held.key === key ? held : fresh;
  const hasMore = nextAt !== undefined && !request.stalled && (!device || device === own);
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
  return { hasMore, loading: request.loading, error: request.error, nextAt, more };
}

/** How far older settled threads have loaded: more to ask for, loading, failed, or all in. */
export type SettledFoot = "more" | "loading" | "error" | undefined;

/** The foot a list of settled threads shows while older ones are left, loading or failed. */
export function settledFoot(paging: SettledPaging): SettledFoot {
  if (paging.loading) return "loading";
  if (paging.error) return "error";
  return paging.hasMore ? "more" : undefined;
}
