import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useConnectionState } from "@ace/client-react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
export function QueryState(props: {
  query: Pick<UseQueryResult, "isFetching" | "error" | "data" | "refetch">;
}) {
  const ready = useConnectionState() === "ready";
  if (!ready) return <p role="status">Offline. Reconnect to refresh this repository.</p>;
  if (props.query.error)
    return (
      <div role="alert" className="space-y-2 text-status-failed">
        <p>{props.query.error.message}</p>
        <Button onClick={() => void props.query.refetch()}>Retry</Button>
      </div>
    );
  // A background poll keeps the shown data; only a first read has nothing to show yet.
  if (props.query.isFetching && props.query.data === undefined)
    return <Spinner label="Reading GitHub" />;
  return null;
}

/**
 * Whether the shown data was read since the connection last came back. Writes wait for that
 * read, since GitHub may have changed while this device was away; background polls while
 * connected never make it stale.
 */
export function useFreshSinceReconnect(dataUpdatedAt: number): boolean {
  const ready = useConnectionState() === "ready";
  // When the connection dropped: the read time of the data shown then. Adjusted during render.
  const [lostAt, setLostAt] = useState<number>();
  if (!ready && lostAt === undefined) setLostAt(dataUpdatedAt);
  if (ready && lostAt !== undefined && dataUpdatedAt > lostAt) setLostAt(undefined);
  return ready && lostAt === undefined;
}
