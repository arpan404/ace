import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useClient, useConnectionState, useSidebarAll } from "@ace/client-react";
import { ThreadId, WorkspaceId, type ForgeRepository } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { QueryState } from "./query-state.tsx";
import { IssueEditor } from "./issue-editor.tsx";
import { IssueTimeline } from "./issue-timeline.tsx";
import { readForge, forgeError } from "./source.ts";
import { openExternal } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { refreshIssueLists } from "./issue-cache.ts";

export function IssueDetail(props: {
  workspaceId: string;
  repository?: ForgeRepository | undefined;
  number: number;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const toast = useToast();
  const cache = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [threadId, setThread] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const choices =
    useSidebarAll((reader) =>
      reader.ids.flatMap((id) => {
        const thread = reader.thread(id);
        return thread ? [{ id, title: thread.title }] : [];
      }),
    ) ?? [];
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, props.repository, "issue", props.number],
    retry: false,
    staleTime: 15000,
    refetchOnReconnect: "always",
    read: async (readerClient, signal) => {
      const value = await readForge(
        readerClient,
        {
          op: "forge.issue.detail",
          workspaceId: props.workspaceId,
          repository: props.repository,
          number: props.number,
        },
        signal,
      );
      if (value.resource !== "issueDetail") throw new Error("No issue detail.");
      return value.value;
    },
  });
  const detail = query.data;
  const refresh = () => {
    if (detail) refreshIssueLists(cache, props.workspaceId, detail.ref.repository);
    void query.refetch();
    setRevision((value) => value + 1);
  };
  const state = async () => {
    if (!detail || pending || !ready || query.isError || query.isFetching) return;
    setPending(true);
    try {
      const result = await client.command({
        type: "forge.issue.write",
        workspaceId: WorkspaceId.parse(props.workspaceId),
        repository: detail.ref.repository,
        input: {
          action: "state",
          number: detail.ref.number,
          expectedUpdatedAt: detail.updatedAt,
          state: detail.state === "open" ? "closed" : "open",
        },
      });
      setMessage(result.ok ? "Issue state saved." : forgeError(result.error ?? "action_failed"));
      if (result.ok)
        refreshIssueLists(cache, props.workspaceId, detail.ref.repository, {
          previous: detail,
          next: { ...detail, state: detail.state === "open" ? "closed" : "open" },
        });
    } catch {
      setMessage("Could not save the action on this device.");
    } finally {
      setPending(false);
      refresh();
    }
  };
  const attach = async () => {
    if (!detail || !threadId) return;
    setPending(true);
    try {
      const result = await client.command({
        type: "forge.issue.link",
        threadId: ThreadId.parse(threadId),
        issue: detail.ref,
      });
      setMessage(result.ok ? "Issue linked to task." : forgeError(result.error ?? "action_failed"));
    } catch {
      setMessage("Could not attach the issue.");
    } finally {
      setPending(false);
      refresh();
    }
  };
  return (
    <article aria-label={`Issue #${props.number}`} className="space-y-5">
      <Button onClick={refresh}>Refresh issue</Button>
      <QueryState query={query} />
      {detail && (
        <>
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-title">
              {detail.title} <span className="text-muted-foreground">#{detail.ref.number}</span>
            </h2>
            <p className="text-sm text-muted-foreground">
              {detail.state} · {detail.author} · {detail.createdAt}
            </p>
            <p className="text-sm">
              Labels: {detail.labels.join(", ") || "None"} · Assignees:{" "}
              {detail.assignees.join(", ") || "None"} · Milestone: {detail.milestone ?? "None"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                void openExternal(detail.url).catch(() =>
                  toast.error({ title: "Couldn't open GitHub" }),
                )
              }
            >
              Open issue on GitHub
            </Button>
            <Button disabled={!ready || !detail.permissions.edit} onClick={() => setEdit(!edit)}>
              {edit ? "Hide editor" : "Edit issue"}
            </Button>
            <Button
              disabled={
                !ready ||
                pending ||
                query.isError ||
                query.isFetching ||
                (detail.state === "open" ? !detail.permissions.close : !detail.permissions.reopen)
              }
              onClick={() => void state()}
            >
              {detail.state === "open" ? "Close issue" : "Reopen issue"}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{detail.permissions.reason}</p>
          <Prose text={detail.body || "No description provided."} />
          {edit && (
            <IssueEditor
              key={JSON.stringify(detail.ref)}
              workspaceId={props.workspaceId}
              repository={detail.ref.repository}
              number={detail.ref.number}
              title={detail.title}
              body={detail.body}
              updatedAt={detail.updatedAt}
              action="edit"
              disabled={!detail.permissions.edit}
              onSaved={() => {
                setEdit(false);
                refresh();
              }}
            />
          )}
          <section className="space-y-3 border-t border-border pt-4" aria-label="Issue agent tasks">
            <h3 className="font-medium">Agent tasks</h3>
            <Link
              className="text-link hover:underline focus-ring"
              to="/new"
              search={{ project: props.workspaceId, issue: detail.url }}
            >
              Start task from issue
            </Link>
            <ul>
              {detail.relatedThreads.map((thread) => (
                <li key={thread.id}>
                  <Link
                    to="/t/$threadId"
                    params={{ threadId: thread.id }}
                    className="text-link hover:underline focus-ring"
                  >
                    {thread.title}
                  </Link>{" "}
                  · {thread.archived ? "Archived" : "Active"}
                </li>
              ))}
            </ul>
            {detail.relatedThreadsTruncated && <p>Showing the first 100 related tasks.</p>}
            <div className="flex flex-wrap gap-2">
              <Select
                label="Existing issue task"
                className="w-64"
                value={threadId}
                onValueChange={setThread}
                options={[
                  { value: "", label: "Choose an existing task" },
                  ...choices.map((thread) => ({ value: thread.id, label: thread.title })),
                ]}
              />
              <Button disabled={!ready || pending || !threadId} onClick={() => void attach()}>
                Attach issue
              </Button>
            </div>
          </section>
          {message && <p role="status">{message}</p>}
          <IssueTimeline workspaceId={props.workspaceId} issue={detail.ref} revision={revision} />
          <IssueEditor
            key={`comment:${JSON.stringify(detail.ref)}`}
            workspaceId={props.workspaceId}
            repository={detail.ref.repository}
            number={detail.ref.number}
            action="comment"
            disabled={!detail.permissions.comment}
            onSaved={refresh}
          />
        </>
      )}
    </article>
  );
}
