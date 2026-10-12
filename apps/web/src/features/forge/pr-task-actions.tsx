import { useState } from "react";
import * as z from "zod/mini";
import { Link } from "@tanstack/react-router";
import { useClient, useConnectionState, useSidebarAll } from "@ace/client-react";
import { ThreadId, type ForgePrDetail } from "@ace/protocol";
import { readJson, writeJson } from "@ace/ui-core";
import { useLayout } from "@/lib/layout.tsx";
import { useWorktreeCreation, WorktreeCreationCard } from "@/features/thread/index.ts";
import { Button } from "@/components/ui/button.tsx";
import { forgeError } from "./source.ts";

export function PrTaskActions(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onRefresh(): void;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const { storage } = useLayout();
  const choices =
    useSidebarAll((reader) =>
      reader.ids.flatMap((id) => {
        const thread = reader.thread(id);
        return thread?.workspaceId === props.workspaceId ? [{ id, title: thread.title }] : [];
      }),
    ) ?? [];
  const [threadId, setThread] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const key = `ace.pr.worktree:${JSON.stringify([props.workspaceId, props.detail.status.ref])}`;
  const [commandId, setCommand] = useState(() =>
    readJson(storage, key, z.optional(z.string()), undefined),
  );
  const worktree = useWorktreeCreation(commandId);
  const prepare = async () => {
    const id = crypto.randomUUID();
    setCommand(id);
    writeJson(storage, key, id);
    setPending(true);
    setMessage("Preparing the selected PR head. The previous checkout is retained.");
    try {
      const result = await client.command(
        {
          type: "forge.pr.worktree",
          threadId: ThreadId.parse(threadId),
          pullRequest: { ref: props.detail.status.ref, headSha: props.detail.status.headSha },
        },
        {},
        id,
      );
      setMessage(
        result.ok
          ? "PR worktree is ready. Open the task to continue."
          : forgeError(result.error ?? "action_failed"),
      );
      if (result.ok) props.onRefresh();
    } catch {
      setMessage("This device couldn't save the request. Try again.");
    } finally {
      setPending(false);
    }
  };
  const running =
    worktree.state?.progress?.state === "running" ||
    worktree.state?.progress?.state === "cancelling";
  return (
    <section aria-label="Work on pull request" className="space-y-3">
      <Link
        className="text-link hover:underline focus-ring"
        to="/new"
        search={{ project: props.workspaceId, pullRequest: props.detail.status.url }}
      >
        Work on PR in a new task
      </Link>
      <p className="text-sm text-muted-foreground">
        Prepare an isolated checkout at {props.detail.status.headSha.slice(0, 12)}. The task's
        agents and terminals must be stopped before switching.
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Task for PR worktree"
          className="bg-input p-1 focus-ring"
          value={threadId}
          onChange={(e) => setThread(e.target.value)}
        >
          <option value="">Choose a task in this project</option>
          {choices.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title}
            </option>
          ))}
        </select>
        <Button
          disabled={!ready || pending || running || !threadId || !props.detail.headRepository}
          onClick={() => void prepare()}
        >
          Work on PR in selected task
        </Button>
        {threadId && (
          <Link
            className="text-link hover:underline focus-ring"
            to="/t/$threadId"
            params={{ threadId }}
          >
            Open selected task
          </Link>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {worktree.state && <WorktreeCreationCard state={worktree.state} onAction={worktree.act} />}
    </section>
  );
}
