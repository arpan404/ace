import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  ForgeHostedReviewCommand,
  ForgePrRef,
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
/**
 * Which pull request this is, as plain values that don't change between polls, so every
 * comment can read it without re-rendering whenever the PR's details are read again.
 */
export interface PrIdentity {
  workspaceId: string;
  /** The PR's ref as one string, for keys (drafts kept on this device). */
  prKey: string;
  url: string;
}
const Identity = createContext<PrIdentity | null>(null);
/** The whole PR as last read, for the few places that need more than its identity. */
const Detail = createContext<ForgePrDetail | null>(null);
const Context = createContext<{
  state?: ForgeReviewState | undefined;
  pending: boolean;
  ready: boolean;
  run(action: ForgeReviewAction): Promise<boolean>;
  /** Inline comments whose suggestions wait to be committed together. */
  batch: readonly number[];
  toggleBatch(commentId: number): void;
  clearBatch(): void;
  /** The conversation is locked to this account: comments, reviews and reactions are refused. */
  commentsLocked: boolean;
} | null>(null);
/** What a locked conversation refuses from someone who can't push. */
const lockedKinds: ReadonlySet<ForgeReviewAction["kind"]> = new Set([
  "conversation",
  "reply",
  "line.comment",
  "submit",
  "draft.save",
  "comment.edit",
  "reaction.add",
  "reaction.remove",
]);
export function PrReviewWorkspace(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onRefresh(): void;
  disabled?: boolean;
  /** A locked conversation this account can't comment on. */
  commentsLocked?: boolean;
  header?: ReactNode;
  children: ReactNode;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [batch, setBatch] = useState<readonly number[]>([]);
  // The ref as a value that stays the same object while it names the same PR.
  const prKey = JSON.stringify(props.detail.status.ref);
  const pr = useMemo(() => ForgePrRef.parse(JSON.parse(prKey)), [prKey]);
  const url = props.detail.status.url;
  const identity = useMemo(
    () => ({ workspaceId: props.workspaceId, prKey, url }),
    [props.workspaceId, prKey, url],
  );
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
  // The latest refresh, so `run` (and the context) stays the same across the page's renders.
  const refreshRef = useRef(props.onRefresh);
  useLayoutEffect(() => {
    refreshRef.current = props.onRefresh;
  });
  const refetch = query.refetch;
  const disabled = props.disabled ?? false;
  const commentsLocked = props.commentsLocked ?? false;
  const run = useCallback(
    async (action: ForgeReviewAction) => {
      if (action.kind !== "reconcile" && (disabled || pending || !ready)) return false;
      if (commentsLocked && lockedKinds.has(action.kind)) {
        setMessage("This conversation is locked. Only collaborators who can push can comment.");
        return false;
      }
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
        refreshRef.current();
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
    [client, workspaceId, pr, refetch, disabled, commentsLocked, pending, ready],
  );
  const toggleBatch = useCallback(
    (id: number) =>
      setBatch((current) =>
        current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      ),
    [],
  );
  const clearBatch = useCallback(() => setBatch([]), []);
  const value = useMemo(
    () => ({
      state: query.data,
      pending: pending || disabled,
      ready: ready && !disabled,
      run,
      batch,
      toggleBatch,
      clearBatch,
      commentsLocked,
    }),
    [query.data, pending, ready, run, disabled, batch, toggleBatch, clearBatch, commentsLocked],
  );
  const uncertain = (query.data?.operations ?? []).filter((op) => op.state === "uncertain");
  return (
    <Identity value={identity}>
      <Detail value={props.detail}>
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
      </Detail>
    </Identity>
  );
}
export function usePrReview() {
  return useContext(Context);
}
/** Which pull request the review is on; null outside one. */
export function usePrIdentity() {
  return useContext(Identity);
}
/** The pull request as last read; it changes with every read that changed anything. */
export function usePrDetail() {
  return useContext(Detail);
}
