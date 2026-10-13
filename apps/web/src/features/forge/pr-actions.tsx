import { PrTaskActions } from "./pr-task-actions.tsx";
import { useClient, useConnectionState, useSidebarAll } from "@ace/client-react";
import type { ForgePrDetail, CommandPayload } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Link } from "@tanstack/react-router";
import { useStackMemberships } from "./pr-stack-groups.tsx";
import { useState } from "react";
import { runCommand, CommandRefused } from "@/lib/daemon-command.ts";
import { forgeError } from "./source.ts";

export function PrActions(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  writeReady: boolean;
  onRefresh(): Promise<boolean>;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const choices =
    useSidebarAll((reader) =>
      reader.ids.flatMap((id) => {
        const thread = reader.thread(id);
        return thread ? [{ id, title: thread.title }] : [];
      }),
    ) ?? [];
  const [threadId, setThread] = useState(props.detail.relatedThreads[0]?.id ?? "");
  const [reviewers, setReviewers] = useState("");
  const [method, setMethod] = useState<"squash" | "merge" | "rebase">("squash");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const blocked = reconciling || props.detail.writeState !== undefined || !props.writeReady;
  const ref = props.detail.status.ref;
  const run = async (payload: CommandPayload) => {
    const remote =
      payload.type === "forge.pr.merge" ||
      payload.type === "forge.pr.auto-merge" ||
      payload.type === "forge.review.request";
    if (
      !ready ||
      pending ||
      !props.writeReady ||
      (remote && (blocked || props.detail.status.state !== "open"))
    )
      return;
    setPending(true);
    if (remote) setReconciling(true);
    setMessage("");
    try {
      const result = await runCommand(client, payload);
      setMessage(result.code ? forgeError(result.code) : "Saved.");
    } catch (error) {
      setMessage(
        error instanceof CommandRefused
          ? forgeError(error.code)
          : error instanceof Error
            ? error.message
            : "The action failed. Refresh GitHub before trying again.",
      );
    } finally {
      try {
        if (await props.onRefresh()) setReconciling(false);
      } catch {
        // Keep the fence when the read fails; the daemon retains it across reloads.
      }
      setPending(false);
    }
  };
  const link = { threadId, pr: ref };
  const associated = props.detail.relatedThreads.some((thread) => thread.id === threadId);
  const active = props.detail.status.state === "open";
  const membership = useStackMemberships(props.workspaceId, ref.repository, [ref.number]);
  const nativeStackOrUnknown = membership.mergeBlocker !== undefined;
  return (
    <section
      aria-label="Linked tasks and pull request actions"
      className="space-y-3 border-t border-border py-4"
    >
      <h3 className="text-sm font-medium">Agent tasks</h3>
      <PrTaskActions
        key={JSON.stringify([props.workspaceId, ref])}
        workspaceId={props.workspaceId}
        detail={props.detail}
        onRefresh={props.onRefresh}
      />
      {props.detail.relatedThreads.length ? (
        <ul>
          {props.detail.relatedThreads.map((thread) => (
            <li key={thread.id}>
              <Link
                className="text-link hover:underline focus-ring"
                to="/t/$threadId"
                params={{ threadId: thread.id }}
              >
                {thread.title}
              </Link>
              {thread.archived ? " · Archived" : " · Active"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No linked agent tasks.</p>
      )}
      {props.detail.relatedThreadsTruncated && <p>Showing the first 100 linked tasks.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 text-sm">
          Existing task
          <Select
            label="Existing task"
            className="w-64"
            value={threadId}
            onValueChange={setThread}
            options={[
              { value: "", label: "Choose a task" },
              ...[
                ...choices,
                ...props.detail.relatedThreads.filter((t) => !choices.some((c) => c.id === t.id)),
              ].map((thread) => ({ value: thread.id, label: thread.title })),
            ]}
          />
        </span>
        <Button
          disabled={!ready || pending || blocked || !threadId || associated}
          onClick={() => void run({ type: "forge.pr.link", link })}
        >
          Link to task
        </Button>
      </div>
      {associated ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 text-sm">
            Merge method
            <Select<"merge" | "rebase" | "squash">
              label="Merge method"
              value={method}
              onValueChange={setMethod}
              options={[
                { value: "squash", label: "Squash" },
                { value: "merge", label: "Merge commit" },
                { value: "rebase", label: "Rebase" },
              ]}
            />
          </span>
          <Button
            disabled={
              !ready ||
              pending ||
              blocked ||
              !active ||
              nativeStackOrUnknown ||
              props.detail.status.mergeability !== "mergeable" ||
              props.detail.status.ci === "failure" ||
              props.detail.status.ci === "pending" ||
              props.detail.status.ci === "unknown"
            }
            onClick={() =>
              void run({
                type: "forge.pr.merge",
                link,
                method,
                headSha: props.detail.status.headSha,
              })
            }
          >
            Merge PR
          </Button>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run({
                type: "forge.review.request",
                link,
                reviewers: reviewers.split(/[\s,]+/).filter(Boolean),
              });
            }}
          >
            <Input
              aria-label="Reviewers"
              value={reviewers}
              onChange={(e) => setReviewers(e.target.value)}
              placeholder="GitHub usernames"
              pattern="[\\w, -]+"
            />
            <Button
              type="submit"
              disabled={!ready || pending || blocked || !active || !reviewers.trim()}
            >
              Request review
            </Button>
          </form>
          <Button
            disabled={!ready || pending || blocked}
            onClick={() =>
              void run({
                type: "forge.pr.unlink",
                threadId: ThreadId.parse(threadId),
                number: ref.number,
                repo: ref.repository,
              })
            }
          >
            Unlink from task
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Link this PR to a task to use its existing merge and review controls.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {(reconciling || props.detail.writeState !== undefined) && (
        <div className="space-y-2">
          <p>Refresh GitHub to reconcile the previous action before making another change.</p>
          <Button
            disabled={!ready || pending}
            onClick={async () => {
              setPending(true);
              try {
                if (await props.onRefresh()) setReconciling(false);
              } catch {
                setMessage("GitHub is still unavailable. Refresh to reconcile the action.");
              } finally {
                setPending(false);
              }
            }}
          >
            Reconcile action
          </Button>
        </div>
      )}
    </section>
  );
}
