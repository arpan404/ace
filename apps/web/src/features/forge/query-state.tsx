import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useConnectionState } from "@ace/client-react";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, SkeletonText } from "@/components/ui/skeleton.tsx";
import type { ForgeKind } from "@ace/protocol/forge";
import { forgeErrorText } from "@ace/ui-core";
import { ForgeReadError, failureCode } from "@/lib/forge-read.ts";

/**
 * A failed read in words: its code's sentence on the Git host it was read from (`forge`, else
 * the one the read named), or the error's own when it has no code.
 */
export function readFailureText(error: Error, forge?: ForgeKind): string {
  const code = failureCode(error);
  if (!code) return error.message;
  return forgeErrorText(code, forge ?? (error instanceof ForgeReadError ? error.forge : undefined));
}
export function QueryState(props: {
  /** What is loading, as in "Loading <label>". */
  label: string;
  query: Pick<UseQueryResult, "isFetching" | "error" | "data" | "refetch">;
  /** The Git host read, so a failure names its CLI. */
  forge?: ForgeKind | undefined;
}) {
  const ready = useConnectionState() === "ready";
  if (!ready) return <p role="status">Offline. Reconnect to refresh this repository.</p>;
  if (props.query.error)
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-muted-foreground">
        {readFailureText(props.query.error, props.forge)}
        <Button size="sm" onClick={() => void props.query.refetch()}>
          Retry
        </Button>
      </p>
    );
  // A background poll keeps the shown data; only a first read has nothing to show yet.
  if (props.query.isFetching && props.query.data === undefined)
    return (
      <LoadingRegion label={props.label}>
        <SkeletonText lines={3} />
      </LoadingRegion>
    );
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
