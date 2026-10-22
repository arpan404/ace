import { createContext, useContext, useState, useMemo, useCallback, type ReactNode } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  ForgeHostedReviewCommand,
  type ForgePrDetail,
  type ForgeReviewAction,
  type ForgeReviewState,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { runCommand, CommandRefused } from "@/lib/daemon-command.ts";
import { actionErrorText } from "@ace/ui-core";
import { readForge } from "@/lib/forge-read.ts";
import { Button } from "@/components/ui/button.tsx";
import { readFailureText } from "./query-state.tsx";
const Context = createContext<{
  /** The pull request the review acts on, as last read. */
  detail: ForgePrDetail;
  workspaceId: string;
  state?: ForgeReviewState | undefined;
  pending: boolean;
  ready: boolean;
  run(action: ForgeReviewAction): Promise<boolean>;
  /** Inline comments whose suggestions wait to be committed together. */
  batch: readonly number[];
  toggleBatch(commentId: number): void;
  clearBatch(): void;
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
  const [batch, setBatch] = useState<readonly number[]>([]);
  const pr = props.detail.status.ref;
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, pr, "review-state", props.detail.status.headSha],
    retry: false,
    gcTime: keptForgeMs,
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
        // The result shows where it was made (the new comment, the resolved thread).
        setMessage("");
        void refetch();
        onRefresh();
        return true;
      } catch (error) {
        setMessage(
          error instanceof CommandRefused
            ? actionErrorText(error.code)
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
  const toggleBatch = useCallback(
    (id: number) =>
      setBatch((current) =>
        current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      ),
    [],
  );
  const clearBatch = useCallback(() => setBatch([]), []);
  const detail = props.detail;
  const value = useMemo(
    () => ({
      detail,
      workspaceId,
      state: query.data,
      pending: pending || disabled,
      ready: ready && !disabled,
      run,
      batch,
      toggleBatch,
      clearBatch,
    }),
    [
      detail,
      workspaceId,
      query.data,
      pending,
      ready,
      run,
      disabled,
      batch,
      toggleBatch,
      clearBatch,
    ],
  );
  const uncertain = (query.data?.operations ?? []).filter((op) => op.state === "uncertain");
  return (
    <Context value={value}>
      {props.header}
      {(message || query.error || uncertain.length > 0) && (
        <div
          className="shrink-0 space-y-1 px-[var(--forge-gutter,1rem)] pb-1 text-xs"
          aria-label="GitHub review status"
        >
          {query.error && (
            <p role="status" className="text-muted-foreground">
              {readFailureText(query.error)}
            </p>
          )}
          {message && (
            <p role="status" className="text-muted-foreground">
              {message}
            </p>
          )}
          {uncertain.map((op) => (
            <p key={op.id} role="status" className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Review change not confirmed</span>
              <Button
                size="xs"
                disabled={!ready || pending}
                onClick={() => void run({ kind: "reconcile", operationId: op.id })}
              >
                Reconcile write
              </Button>
            </p>
          ))}
        </div>
      )}
      {props.children}
    </Context>
  );
}
export function usePrReview() {
  return useContext(Context);
}
