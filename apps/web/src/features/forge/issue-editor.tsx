import { useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  WorkspaceId,
  CommandId,
  type ForgeRepository,
  type ForgeIssueWrite,
  type ForgeIssueRef,
} from "@ace/protocol";
import * as z from "zod/mini";
import { readJson, writeJson } from "@ace/ui-core";
import { useLayout } from "@/lib/layout.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { readForge, forgeError } from "./source.ts";

const Draft = z.object({ title: z.string(), body: z.string() });
export function IssueEditor(props: {
  workspaceId: string;
  repository: ForgeRepository;
  number?: number | undefined;
  title?: string | undefined;
  body?: string | undefined;
  action: "create" | "edit" | "comment";
  updatedAt?: string | undefined;
  disabled?: boolean | undefined;
  onSaved(issue: ForgeIssueRef): void;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const { storage } = useLayout();
  const key = `ace.issue.draft:${JSON.stringify([props.workspaceId, props.repository, props.number ?? 0, props.action])}`;
  const [draft, setDraft] = useState(() =>
    readJson(storage, key, Draft, { title: props.title ?? "", body: props.body ?? "" }),
  );
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
  const update = (next: typeof draft) => {
    setDraft(next);
    writeJson(storage, key, next);
  };
  const submit = async () => {
    const input: ForgeIssueWrite =
      props.action === "create"
        ? { action: "create", ...draft }
        : props.action === "comment"
          ? { action: "comment", number: props.number ?? 0, body: draft.body }
          : {
              action: "edit",
              number: props.number ?? 0,
              expectedUpdatedAt: props.updatedAt ?? "",
              ...draft,
            };
    setPending(true);
    setMessage("Waiting for GitHub. This action is saved on this device.");
    try {
      const result = await client.command({
        type: "forge.issue.write",
        workspaceId: WorkspaceId.parse(props.workspaceId),
        repository: props.repository,
        input,
      });
      if (result.ok && result.issue) {
        update({ title: "", body: "" });
        setMessage("Saved on GitHub.");
        props.onSaved(result.issue);
      } else
        setMessage(
          result.issueAction?.state === "uncertain"
            ? "The outcome is uncertain. Reconcile before another write. Your draft is saved."
            : forgeError(result.error ?? "action_failed"),
        );
    } catch {
      setMessage("This device couldn't save the action. Your draft is preserved.");
    } finally {
      setPending(false);
      void actions.refetch();
    }
  };
  const reconcile = async (id: string) => {
    setPending(true);
    try {
      const result = await client.command({
        type: "forge.issue.reconcile",
        workspaceId: WorkspaceId.parse(props.workspaceId),
        repository: props.repository,
        actionId: CommandId.parse(id),
      });
      if (result.ok && result.issue) {
        setMessage("GitHub confirmed the action.");
        props.onSaved(result.issue);
      } else
        setMessage(
          "GitHub has not confirmed the outcome. Check GitHub before continuing; ace will not repeat this write.",
        );
    } catch {
      setMessage("Could not reconcile. Reconnect and try reconciliation again.");
    } finally {
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
            maxLength={256}
            onChange={(e) => update({ ...draft, title: e.target.value })}
          />
        )}
        <textarea
          aria-label={props.action === "comment" ? "Issue comment" : "Issue body"}
          className="w-full min-h-32 rounded-md border border-border bg-input p-3 text-sm focus-ring"
          maxLength={64000}
          value={draft.body}
          onChange={(e) => update({ ...draft, body: e.target.value })}
        />
        <Button
          type="submit"
          disabled={
            !ready ||
            pending ||
            props.disabled ||
            !actions.isSuccess ||
            uncertain.length > 0 ||
            (props.action === "comment" ? !draft.body.trim() : !draft.title.trim())
          }
        >
          {props.action === "create"
            ? "Create issue"
            : props.action === "edit"
              ? "Save issue"
              : "Post issue comment"}
        </Button>
      </form>
      {message && <p role="status">{message}</p>}
      {uncertain.map((action) => (
        <div key={action.id} className="space-y-2">
          <p>
            Uncertain {action.action} · {action.id}
          </p>
          <Button disabled={!ready || pending} onClick={() => void reconcile(action.id)}>
            Reconcile action
          </Button>
        </div>
      ))}
      {actions.isError && (
        <p role="alert">
          The action journal could not load.{" "}
          <Button onClick={() => void actions.refetch()}>Reload actions</Button>
        </p>
      )}
    </section>
  );
}
