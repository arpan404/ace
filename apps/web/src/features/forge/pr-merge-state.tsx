import { useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import type { ForgePrDetail, ForgeMergeState, ForgePrRef } from "@ace/protocol";
import { autoMergeBlocker } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { runCommand, CommandRefused } from "@/lib/daemon-command.ts";
import { readForge, forgeError } from "./source.ts";
import { QueryState } from "./query-state.tsx";

export function MergeStateSummary({ state }: { state: ForgeMergeState }) {
  return (
    <div className="space-y-2 text-sm">
      <p>
        {state.autoMerge
          ? `Auto-merge enabled: ${state.autoMerge.method.toLowerCase()} by ${state.autoMerge.actor ?? "unknown actor"} at ${state.autoMerge.enabledAt}.`
          : "Auto-merge is disabled."}
      </p>
      <p>
        {state.queue
          ? `Merge queue: ${state.queue.state}, position ${state.queue.position}. Enqueued at ${state.queue.enqueuedAt}.`
          : "Not in the merge queue."}
      </p>
      <ul aria-label="Merge blockers">
        {state.blockers.map((blocker) => (
          <li key={blocker}>{blocker}</li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        GitHub evaluates required checks, reviews and repository rules when merging. Green CI alone
        does not establish eligibility.
      </p>
    </div>
  );
}
export function PrMergeState(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onRefresh(): void;
}) {
  return (
    <PrMergeControls
      workspaceId={props.workspaceId}
      pr={props.detail.status.ref}
      relatedThreads={props.detail.relatedThreads}
      onRefresh={props.onRefresh}
    />
  );
}

/** Shared by the hosted PR workspace and the linked thread's PR controls. */
export function PrMergeControls(props: {
  workspaceId: string;
  pr: ForgePrRef;
  relatedThreads: readonly { id: string; title: string }[];
  onRefresh(): void;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const ref = props.pr;
  const [threadId, setThread] = useState(props.relatedThreads[0]?.id ?? "");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, ref, "merge-state"],
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchInterval: 15_000,
    read: async (reader, signal) => {
      const result = await readForge(
        reader,
        {
          op: "forge.pr.merge-state",
          workspaceId: props.workspaceId,
          repository: ref.repository,
          number: ref.number,
        },
        signal,
      );
      if (result.resource !== "prMergeState") throw new Error("No merge state returned.");
      return result.value;
    },
  });
  const state = query.data;
  const associated = props.relatedThreads.some((thread) => thread.id === threadId);
  const disabled =
    !ready ||
    pending ||
    query.isFetching ||
    query.isError ||
    !state ||
    !associated ||
    uncertain ||
    state.writeState !== undefined;
  const run = async (action: "enable" | "disable" | "dequeue") => {
    if (disabled || !state) return;
    setPending(true);
    setMessage("");
    try {
      const result = await runCommand(client, {
        type: "forge.pr.merge-state.change",
        link: { threadId, pr: ref },
        headSha: state.headSha,
        action,
        method,
      });
      setMessage(
        result.code
          ? forgeError(result.code)
          : "GitHub confirmed the action. Refreshing current state.",
      );
    } catch (error) {
      setUncertain(true);
      setMessage(
        error instanceof CommandRefused
          ? error.code === "action_outcome_uncertain"
            ? "The action may have reached GitHub. Refresh merge state before taking another action."
            : forgeError(error.code)
          : "The acknowledgement was lost. Refresh GitHub state before taking another action.",
      );
    } finally {
      await query.refetch();
      props.onRefresh();
      setPending(false);
    }
  };
  return (
    <section
      aria-label="Auto-merge and merge queue"
      className="space-y-3 border-t border-border py-4"
    >
      <h3 className="text-base font-medium">Auto-merge and merge queue</h3>
      <QueryState query={query} />
      {state && !query.isError && <MergeStateSummary state={state} />}
      {state?.writeState && (
        <p role="status">
          {forgeError(
            state.writeState === "pending" ? "forge_write_pending" : "forge_write_uncertain",
          )}
        </p>
      )}
      <Button
        disabled={!ready || pending || query.isFetching}
        onClick={async () => {
          const result = await query.refetch();
          if (result.isSuccess) setUncertain(false);
        }}
      >
        Refresh merge state
      </Button>
      <label className="block text-sm">
        Linked task{" "}
        <select
          aria-label="Merge state task"
          value={threadId}
          onChange={(event) => setThread(event.target.value)}
          className="bg-input p-1 focus-ring"
        >
          <option value="">Choose a linked task</option>
          {props.relatedThreads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title}
            </option>
          ))}
        </select>
      </label>
      {!associated && (
        <p className="text-sm text-muted-foreground">
          Link this PR to a task to change auto-merge or its queue membership.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">
          Auto-merge method{" "}
          <select
            aria-label="Auto-merge method"
            className="bg-input p-1 focus-ring"
            value={method}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "merge" || value === "squash" || value === "rebase") setMethod(value);
            }}
          >
            <option value="squash">Squash</option>
            <option value="merge">Merge commit</option>
            <option value="rebase">Rebase</option>
          </select>
        </label>
        <Button disabled={disabled || !!autoMergeBlocker(state)} onClick={() => void run("enable")}>
          Enable auto-merge
        </Button>
        <Button
          disabled={disabled || !state?.canDisable || !state.autoMerge}
          onClick={() => void run("disable")}
        >
          Cancel auto-merge
        </Button>
        <Button
          disabled={disabled || !state?.canDequeue || !state.queue}
          onClick={() => void run("dequeue")}
        >
          Leave merge queue
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
