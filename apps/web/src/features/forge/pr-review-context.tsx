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
  ForgePrRef,
  type ForgePrDetail,
  type ForgeReviewAction,
  type ForgeReviewState,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { lockedText } from "@ace/ui-core";
import { readForge } from "@/lib/forge-read.ts";
import { Button } from "@/components/ui/button.tsx";
import { readFailureText } from "./query-state.tsx";
import {
  useReportedWrites,
  useReviewWrites,
  type ReviewReread,
  type ReviewWriteResult,
} from "./pr-review-writes.ts";
import { useViewedChanges } from "./pr-viewed-overrides.ts";
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
export interface PrReviewContext {
  state?: ForgeReviewState | undefined;
  /** A write reported in the status line under the header is on its way. */
  pending: boolean;
  ready: boolean;
  /** A write whose progress and refusal show in the status line under the header. */
  run(action: ForgeReviewAction): Promise<boolean>;
  /** A write whose caller shows its progress and refusal where it was made. */
  write(action: ForgeReviewAction): Promise<ReviewWriteResult>;
  /** Viewed marks changed here, shown at once while their writes wait their turn. */
  viewed: ReturnType<typeof useViewedChanges>;
  /** Inline comments whose suggestions wait to be committed together. */
  batch: readonly number[];
  toggleBatch(commentId: number): void;
  clearBatch(): void;
  /** The conversation is locked to this account: comments, reviews and reactions are refused. */
  commentsLocked: boolean;
}
const Context = createContext<PrReviewContext | null>(null);
export { lockedText };
export function PrReviewWorkspace(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onRefresh(): void;
  /**
   * Reads again what a review write changed: the PR's threads, or everything but its files.
   * Without it, everything is refreshed.
   */
  onReread?: ((reread: Exclude<ReviewReread, "review">) => Promise<unknown>) | undefined;
  disabled?: boolean;
  /** A locked conversation this account can't comment on. */
  commentsLocked?: boolean | undefined;
  header?: ReactNode;
  children: ReactNode;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
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
  // The latest re-reads, so the writes (and the context) stay the same across renders.
  const refreshRef = useRef(props.onRefresh);
  const rereadRef = useRef(props.onReread);
  useLayoutEffect(() => {
    refreshRef.current = props.onRefresh;
    rereadRef.current = props.onReread;
  });
  const refetch = query.refetch;
  const disabled = props.disabled ?? false;
  const commentsLocked = props.commentsLocked ?? false;
  const onSettled = useCallback(
    async (reread: ReviewReread, ok: boolean) => {
      if (!ok || reread === "review") return refetch();
      const wider = rereadRef.current;
      if (!wider) {
        refreshRef.current();
        return refetch();
      }
      return Promise.all([refetch(), wider(reread)]);
    },
    [refetch],
  );
  const writes = useReviewWrites({
    client,
    workspaceId: props.workspaceId,
    pr,
    ready,
    disabled,
    commentsLocked,
    onSettled,
  });
  const write = writes.write;
  const viewed = useViewedChanges(write);
  const { run, pending, message } = useReportedWrites(write);
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
      pending: pending > 0 || disabled,
      ready: ready && !disabled,
      run,
      write,
      viewed,
      batch,
      toggleBatch,
      clearBatch,
      commentsLocked,
    }),
    [
      query.data,
      pending,
      ready,
      run,
      write,
      viewed,
      disabled,
      batch,
      toggleBatch,
      clearBatch,
      commentsLocked,
    ],
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
                    disabled={!ready || pending > 0}
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
