import { useState, useRef } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  WorkspaceId,
  CommandId,
  type ForgeRepository,
  type ForgeIssueWrite,
  type ForgeIssueRef,
} from "@ace/protocol";
import { readJson, writeJson } from "@ace/ui-core";
import { useLayout } from "@/lib/layout.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { readForge, forgeError } from "./source.ts";
import { IssueDraft, confirmIssueDraft } from "./issue-draft.ts";

export function IssueEditor(props: {
  workspaceId: string;
  repository: ForgeRepository;
  number?: number | undefined;
  title?: string | undefined;
  body?: string | undefined;
  action: "create" | "edit" | "comment";
  updatedAt?: string | undefined;
  disabled?: boolean | undefined;
  actionId?: (() => string) | undefined;
  onSaved(issue: ForgeIssueRef): void;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const { storage } = useLayout();
  const key = `ace.issue.draft:${JSON.stringify([props.workspaceId, props.repository, props.number ?? 0, props.action])}`;
  const [draft, setDraft] = useState(() =>
    readJson(storage, key, IssueDraft, {
      title: props.title ?? "",
      body: props.body ?? "",
      updatedAt: props.updatedAt,
    }),
  );
  const currentDraft = useRef(draft);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const actions = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, props.repository, "issueActions", props.number ?? 0],
    retry: false,
    refetchOnReconnect: "always",
    staleTime: 0,
    read: async (readerClient, signal) => {
      const value = await readForge(
        readerClient,
        {
          op: "forge.issue.actions",
          workspaceId: props.workspaceId,
          repository: props.repository,
          number: props.number ?? 0,
        },
        signal,
      );
      if (value.resource !== "issueActions") throw new Error("No action journal.");
      return value.actions;
    },
  });
  const uncertain =
    actions.data?.filter((action) => action.state === "pending" || action.state === "uncertain") ??
    [];
  const submitted = draft.submission;
  const submissionState = actions.data?.find((action) => action.id === submitted?.id)?.state;
  const outstanding = submitted !== undefined && submissionState !== "failed";
  const canSubmit =
    ready &&
    !pending &&
    !props.disabled &&
    actions.isSuccess &&
    !actions.isFetching &&
    !uncertain.length &&
    !outstanding &&
    (props.action === "comment" ? Boolean(draft.body.trim()) : Boolean(draft.title.trim()));
  const newId = () => (props.actionId ? props.actionId() : crypto.randomUUID());
  const update = (next: typeof draft) => {
    currentDraft.current = next;
    setDraft(next);
    writeJson(storage, key, next);
  };
  const confirm = (id: string) => {
    const latest = readJson(storage, key, IssueDraft, currentDraft.current);
    const next = confirmIssueDraft(latest, id);
    if (next === latest) return;
    if (next) update(next);
    else {
      try {
        if (storage?.removeItem) storage.removeItem(key);
        else writeJson(storage, key, null);
      } catch {
        writeJson(storage, key, null);
      }
      const fresh: IssueDraft = {
        title: props.action === "edit" ? latest.title : "",
        body: props.action === "edit" ? latest.body : "",
        updatedAt: props.updatedAt,
      };
      currentDraft.current = fresh;
      setDraft(fresh);
    }
  };
  const releaseUnsent = (id: string) => {
    const latest = readJson(storage, key, IssueDraft, currentDraft.current);
    if (latest.submission?.id === id) update({ ...latest, submission: undefined });
  };
  const submit = async () => {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    const id = newId();
    const revision = draft.revision ?? newId();
    const snapshot = { ...draft, revision, submission: { id, revision } };
    update(snapshot);
    const input: ForgeIssueWrite =
      props.action === "create"
        ? { action: "create", title: snapshot.title, body: snapshot.body }
        : props.action === "comment"
          ? { action: "comment", number: props.number ?? 0, body: snapshot.body }
          : {
              action: "edit",
              number: props.number ?? 0,
              expectedUpdatedAt: snapshot.updatedAt ?? "",
              title: snapshot.title,
              body: snapshot.body,
            };
    setPending(true);
    setMessage("Waiting for GitHub. This action is saved on this device.");
    try {
      const result = await client.command(
        {
          type: "forge.issue.write",
          workspaceId: WorkspaceId.parse(props.workspaceId),
          repository: props.repository,
          input,
        },
        {},
        id,
      );
      if (result.ok && result.issue) {
        confirm(id);
        setMessage("Saved on GitHub.");
        props.onSaved(result.issue);
      } else {
        if (
          result.commandId === id &&
          (result.code === "action_not_dispatched" ||
            (result.issueAction?.id === id && result.issueAction.state === "failed"))
        )
          releaseUnsent(id);
        setMessage(
          result.issueAction?.state === "uncertain"
            ? "The outcome is uncertain. Reconcile before another write. Your draft is saved."
            : forgeError(result.error ?? "action_failed"),
        );
      }
    } catch {
      if (client.intent(id).getSnapshot()?.localFailure) releaseUnsent(id);
      setMessage("This device couldn't save the action. Your draft is preserved.");
    } finally {
      submitting.current = false;
      setPending(false);
      void actions.refetch();
    }
  };
  const reconcile = async (id: string) => {
    if (!ready || pending || submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      const result = await client.command({
        type: "forge.issue.reconcile",
        workspaceId: WorkspaceId.parse(props.workspaceId),
        repository: props.repository,
        actionId: CommandId.parse(id),
      });
      if (result.ok && result.issue) {
        confirm(id);
        setMessage("GitHub confirmed the action.");
        props.onSaved(result.issue);
      } else if (result.issueAction?.state === "failed") {
        releaseUnsent(id);
        setMessage(forgeError(result.issueAction.error ?? "action_not_dispatched"));
      } else
        setMessage(
          "GitHub has not confirmed the outcome. Check GitHub before continuing; ace will not repeat this write.",
        );
    } catch {
      setMessage("Could not reconcile. Reconnect and try reconciliation again.");
    } finally {
      submitting.current = false;
      setPending(false);
      void actions.refetch();
    }
  };
  return (
    <section className="space-y-3 border-t border-border pt-4" aria-label={`${props.action} issue`}>
      <h3 className="font-medium">
        {props.action === "create"
          ? "New issue"
          : props.action === "edit"
            ? "Edit issue"
            : "Add an issue comment"}
      </h3>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {props.action !== "comment" && (
          <Input
            aria-label="Issue title"
            value={draft.title}
            disabled={pending}
            maxLength={256}
            onChange={(e) => update({ ...draft, title: e.target.value, revision: newId() })}
          />
        )}
        <textarea
          aria-label={props.action === "comment" ? "Issue comment" : "Issue body"}
          className="w-full min-h-32 rounded-md border border-border bg-input p-3 text-sm focus-ring"
          maxLength={64000}
          value={draft.body}
          disabled={pending}
          onChange={(e) => update({ ...draft, body: e.target.value, revision: newId() })}
        />
        <Button type="submit" disabled={!canSubmit}>
          {props.action === "create"
            ? "Create issue"
            : props.action === "edit"
              ? "Save issue"
              : "Post issue comment"}
        </Button>
      </form>
      {message && <p role="status">{message}</p>}
      {props.action === "edit" && draft.updatedAt !== props.updatedAt && (
        <div role="alert">
          This issue changed since the draft started. Saving will check the original version.
          <Button
            disabled={pending || outstanding}
            onClick={() =>
              update({
                title: props.title ?? "",
                body: props.body ?? "",
                updatedAt: props.updatedAt,
                revision: newId(),
              })
            }
          >
            Reload current issue
          </Button>
        </div>
      )}
      {outstanding && !uncertain.some((action) => action.id === submitted?.id) && submitted && (
        <Button
          disabled={!ready || pending || submissionState === "pending"}
          onClick={() => void reconcile(submitted.id)}
        >
          Check submission
        </Button>
      )}
      {uncertain.map((action) => (
        <div key={action.id} className="space-y-2">
          <p>
            {action.state === "pending" ? "Pending" : "Uncertain"} {action.action} · {action.id}
          </p>
          <Button
            disabled={!ready || pending || action.state === "pending"}
            onClick={() => void reconcile(action.id)}
          >
            Reconcile action
          </Button>
        </div>
      ))}
      {uncertain.some((action) => action.state === "pending") && (
        <Button disabled={!ready || pending} onClick={() => void actions.refetch()}>
          Refresh actions
        </Button>
      )}
      {actions.isError && (
        <p role="alert">
          The action journal could not load.{" "}
          <Button onClick={() => void actions.refetch()}>Reload actions</Button>
        </p>
      )}
    </section>
  );
}
