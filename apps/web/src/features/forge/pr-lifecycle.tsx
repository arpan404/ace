import { useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  ForgeHostedLifecycleCommand,
  type ForgePrDetail,
  type ForgeLifecycleAction,
} from "@ace/protocol";
import { prUrl } from "@ace/forge/pr-reference";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { runCommand, CommandRefused } from "@/lib/daemon-command.ts";
import { Button } from "@/components/ui/button.tsx";
import { readForge, forgeError } from "./source.ts";
import { QueryState } from "./query-state.tsx";
import { PrMetadataEditor } from "./pr-metadata-editor.tsx";
import { PrRevertForm } from "./pr-revert-form.tsx";
const labels = {
  ready: "Mark ready for review",
  draft: "Convert to draft",
  close: "Close PR",
  reopen: "Reopen PR",
  "update.merge": "Update branch with merge",
  "update.rebase": "Update branch with rebase",
  revert: "Create revert PR",
};
export function PrLifecycle(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onRefresh(): void;
  refreshVersion?: number;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const pr = props.detail.status.ref;
  const query = useDaemonQuery({
    queryKey: [
      "forge",
      props.workspaceId,
      pr,
      "lifecycle",
      props.refreshVersion,
      props.detail.status.headSha,
      props.detail.status.state,
      props.detail.status.title,
    ],
    retry: false,
    staleTime: 0,
    refetchOnReconnect: "always",
    read: async (readerClient, signal) => {
      const result = await readForge(
        readerClient,
        {
          op: "forge.pr.lifecycle",
          workspaceId: props.workspaceId,
          repository: pr.repository,
          number: pr.number,
        },
        signal,
      );
      if (result.resource !== "prLifecycle") throw new Error("No PR lifecycle response.");
      return result.value;
    },
  });
  const execute = async (
    operation: import("zod").z.infer<typeof ForgeHostedLifecycleCommand>["operation"],
  ) => {
    setPending(true);
    setMessage("Waiting for GitHub…");
    try {
      const result = await runCommand(
        client,
        ForgeHostedLifecycleCommand.parse({
          type: "forge.hosted.lifecycle",
          workspaceId: props.workspaceId,
          pr,
          operation,
        }),
      );
      const receipt = result.forgeLifecycle;
      if (!receipt) throw new Error("action_outcome_uncertain");
      setMessage(
        receipt?.outcome === "pending"
          ? "GitHub accepted the request. The resulting state is still pending. Check the result before another action."
          : receipt?.outcome === "head_changed"
            ? "The branch head changed. Refresh and review its current commits before continuing."
            : receipt?.revertPr
              ? `Created draft revert PR #${receipt.revertPr.number}. Refresh to open it.`
              : "Saved on GitHub.",
      );
      void query.refetch();
      props.onRefresh();
      return receipt?.outcome === "accepted";
    } catch (error) {
      setMessage(
        error instanceof CommandRefused
          ? forgeError(error.code)
          : "Couldn't confirm the action. Refresh and check its result; your edit is retained.",
      );
      void query.refetch();
      return false;
    } finally {
      setPending(false);
    }
  };
  const apply = (action: ForgeLifecycleAction, version: string) =>
    execute({ kind: "apply", expectedVersion: version, action });
  const snapshot = query.data?.snapshot;
  const unresolved = query.data?.operations.some(
    (op) => op.state === "pending" || op.state === "uncertain",
  );
  const disabled = !ready || pending || !snapshot || Boolean(query.error) || unresolved === true;
  return (
    <section
      aria-label="Pull request metadata and lifecycle"
      className="space-y-4 border-t border-border py-4"
    >
      <h3 className="font-medium">Metadata and lifecycle</h3>
      <Button
        disabled={!ready || pending}
        onClick={() => {
          void query.refetch();
          props.onRefresh();
        }}
      >
        Refresh lifecycle
      </Button>
      <QueryState query={query} />
      {message && <p role="status">{message}</p>}
      {query.data?.operations.map((op) => (
        <div key={op.id}>
          {(op.state === "pending" || op.state === "uncertain") && (
            <p role="status">
              {labels[op.kind as keyof typeof labels] ?? "PR edit"}:{" "}
              {op.state === "uncertain"
                ? "GitHub may have accepted this action."
                : "Waiting for the resulting GitHub state."}{" "}
              <Button
                disabled={!ready || pending}
                onClick={() => void execute({ kind: "reconcile", operationId: op.id })}
              >
                Check action result
              </Button>
            </p>
          )}
          {op.revertPr && (
            <a
              className="text-link focus-ring"
              href={prUrl(op.revertPr)}
              target="_blank"
              rel="noreferrer"
            >
              Open draft revert PR #{op.revertPr.number}
            </a>
          )}
        </div>
      ))}
      {snapshot && (
        <>
          <p className="text-sm text-muted-foreground">
            Current state: {snapshot.state}. Actions reflect your GitHub permissions.
          </p>
          <details>
            <summary className="cursor-pointer focus-ring">Edit PR metadata</summary>
            <PrMetadataEditor
              key={JSON.stringify(pr)}
              snapshot={snapshot}
              disabled={disabled}
              apply={apply}
            />
          </details>
          <div className="flex flex-wrap gap-2">
            {snapshot.actions
              .filter((kind) => kind !== "revert")
              .map((kind) => (
                <Button
                  key={kind}
                  disabled={disabled}
                  onClick={() => {
                    if (kind === "close" && !window.confirm("Close this pull request on GitHub?"))
                      return;
                    void apply({ kind }, snapshot.version);
                  }}
                >
                  {labels[kind]}
                </Button>
              ))}
          </div>
          {!snapshot.actions.length && (
            <p className="text-sm text-muted-foreground">
              No lifecycle transitions are available for this state and account.
            </p>
          )}
          {snapshot.unsupported.length > 0 && (
            <p className="text-sm text-muted-foreground">
              This GitHub host does not support:{" "}
              {snapshot.unsupported.map((kind) => labels[kind]).join(", ")}.
            </p>
          )}
          {snapshot.actions.includes("revert") && (
            <details>
              <summary className="cursor-pointer focus-ring">Create a revert PR</summary>
              <PrRevertForm
                key={JSON.stringify(pr)}
                snapshot={snapshot}
                disabled={disabled}
                apply={apply}
              />
            </details>
          )}
        </>
      )}
    </section>
  );
}
