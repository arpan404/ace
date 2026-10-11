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
  if (props.query.isFetching) return <Spinner label="Reading GitHub" />;
  return null;
}
