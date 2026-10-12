import { createContext, useContext, useState, useMemo, useCallback, type ReactNode } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  ForgeHostedReviewCommand,
  type ForgePrDetail,
  type ForgeReviewAction,
  type ForgeReviewState,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { runCommand, CommandRefused } from "@/lib/daemon-command.ts";
import { readForge, forgeError } from "./source.ts";
import { Button } from "@/components/ui/button.tsx";
const Context = createContext<{
  state?: ForgeReviewState | undefined;
  pending: boolean;
  ready: boolean;
  run(action: ForgeReviewAction): Promise<boolean>;
} | null>(null);
export function PrReviewWorkspace(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onRefresh(): void;
  disabled?: boolean;
  header?: ReactNode;
  children: ReactNode;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const pr = props.detail.status.ref;
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, pr, "review-state", props.detail.status.headSha],
    retry: false,
    refetchOnReconnect: "always",
    staleTime: 0,
    read: async (readerClient, signal) => {
      const response = await readForge(
        readerClient,
        {
          op: "forge.pr.review-state",
          workspaceId: props.workspaceId,
          repository: pr.repository,
          number: pr.number,
        },
        signal,
      );
      if (response.resource !== "prReviewState") throw new Error("No hosted review state.");
      return response.value;
    },
  });
  const workspaceId = props.workspaceId;
  const onRefresh = props.onRefresh;
  const refetch = query.refetch;
  const disabled = props.disabled ?? false;
  const run = useCallback(
    async (action: ForgeReviewAction) => {
      if (action.kind !== "reconcile" && (disabled || pending || !ready)) return false;
      setPending(true);
      setMessage("Waiting for GitHub…");
      try {
        await runCommand(
          client,
          ForgeHostedReviewCommand.parse({
            type: "forge.hosted.review",
            workspaceId: workspaceId,
            pr,
            action,
          }),
        );
        setMessage("Saved.");
        void refetch();
        onRefresh();
        return true;
      } catch (error) {
        setMessage(
          error instanceof CommandRefused
            ? forgeError(error.code)
            : "Couldn't confirm the action. Refresh and reconcile its result; your draft is retained.",
        );
        void refetch();
        return false;
      } finally {
        setPending(false);
      }
    },
    [client, workspaceId, pr, refetch, onRefresh, disabled, pending, ready],
  );
  const value = useMemo(
    () => ({ state: query.data, pending: pending || disabled, ready: ready && !disabled, run }),
    [query.data, pending, ready, run, disabled],
  );
  return (
    <Context value={value}>
      {props.header}
      <div className="space-y-2 px-4 py-1.5 text-xs" aria-label="GitHub review status">
        <Button disabled={!ready || pending} onClick={() => void query.refetch()}>
          Refresh review state
        </Button>
        {query.error && (
          <p role="status">GitHub review state is unavailable. Refresh before writing.</p>
        )}
        {message && <p role="status">{message}</p>}
        {query.data?.operations
          .filter((op) => op.state === "uncertain")
          .map((op) => (
            <p key={op.id} role="status">
              A GitHub write has an uncertain outcome.{" "}
              <Button
                disabled={!ready || pending}
                onClick={() => void run({ kind: "reconcile", operationId: op.id })}
              >
                Reconcile write
              </Button>
            </p>
          ))}
      </div>
      {props.children}
    </Context>
  );
}
export function usePrReview() {
  return useContext(Context);
}
