import { useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import type { ForgePrDetail, ForgeStackExpected, ForgeStackOperation } from "@ace/protocol";
import {
  canPublishStack,
  matchesLocalStack,
  matchesStackBranches,
  stackPublicationUnavailable,
} from "@ace/forge/stack-plan";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { readForge, forgeError } from "./source.ts";
import { QueryState } from "./query-state.tsx";

type Confirmation = {
  action: ForgeStackOperation["action"];
  method: "merge" | "squash" | "rebase";
  expected: ForgeStackExpected;
  numbers: number[];
};
export function PrStack(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  onRefresh(): void;
  onOpen(number: number): void;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const ref = props.detail.status.ref;
  const [threadId, setThread] = useState(props.detail.relatedThreads[0]?.id ?? "");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, ref, "stack", threadId],
    retry: false,
    staleTime: 0,
    refetchOnReconnect: "always",
    refetchInterval: 15_000,
    read: async (reader, signal) => {
      const result = await readForge(
        reader,
        {
          op: "forge.pr.stack",
          workspaceId: props.workspaceId,
          repository: ref.repository,
          number: ref.number,
          threadId: threadId ? ThreadId.parse(threadId) : undefined,
        },
        signal,
      );
      if (result.resource !== "prStack") throw new Error("No stack returned.");
      return result.value;
    },
  });
  const stack = query.data?.stack;
  const local = query.data?.local;
  const operation = query.data?.operation;
  const index = stack?.layers.findIndex((layer) => layer.number === ref.number) ?? -1;
  const scope = stack?.layers.slice(0, index + 1) ?? [];
  const incomplete =
    operation && ["pending", "uncertain", "conflict", "push_partial"].includes(operation.state);
  const associated = props.detail.relatedThreads.some((thread) => thread.id === threadId);
  const disabled = !ready || pending || query.isFetching || query.isError || !stack || !associated;
  const canRebase =
    stack && local && !query.data?.localUnavailable && matchesLocalStack(local, stack);
  const canRecover =
    stack && local && !query.data?.localUnavailable && matchesStackBranches(local, stack);
  const canPublish =
    stack &&
    canPublishStack(stack) &&
    stack.layers.every((layer) => layer.queueState === null) &&
    !local?.branches.some((branch) => branch.isQueued);
  const prepare = (action: ForgeStackOperation["action"]) => {
    if (!stack || disabled) return;
    setConfirmation({
      action,
      method,
      expected: {
        id: stack.id,
        trunk: stack.trunk,
        layers: stack.layers.map((layer) => ({ number: layer.number, headSha: layer.headSha })),
        local: local ?? null,
      },
      numbers: (action === "merge"
        ? scope
        : stack.layers.filter((layer) => layer.state !== "MERGED")
      ).map((layer) => layer.number),
    });
  };
  const run = async () => {
    if (!confirmation || disabled) return;
    setPending(true);
    setMessage("");
    try {
      const receipt = await client.command({
        type: "forge.pr.stack.change",
        link: { threadId, pr: ref },
        expected: confirmation.expected,
        action: confirmation.action,
        method: confirmation.method,
      });
      setMessage(
        receipt.stackOperation?.message ??
          (receipt.ok
            ? "GitHub acknowledged the operation. Refreshing state."
            : forgeError(receipt.error ?? "action_failed")),
      );
    } catch {
      setMessage(
        "The acknowledgement was lost. Refresh the stack to reconcile the operation before recovery.",
      );
    } finally {
      setConfirmation(null);
      await query.refetch();
      props.onRefresh();
      setPending(false);
    }
  };
  return (
    <section aria-label="Pull request stack" className="space-y-3 border-t border-border py-4">
      <h3 className="text-base font-medium">Pull request stack</h3>
      <QueryState query={query} />
      <Button disabled={!ready || pending || query.isFetching} onClick={() => void query.refetch()}>
        Refresh stack
      </Button>
      {query.data && !stack && !query.isError && (
        <p>This pull request is not in a native GitHub stack.</p>
      )}
      {stack && !query.isError && (
        <>
          <p>
            Native stack #{stack.number} · trunk {stack.trunk}
          </p>
          <p className="text-sm">
            Merging #{ref.number} requests layers{" "}
            {scope.map((layer) => `#${layer.number}`).join(", ")} together. GitHub enforces the
            trunk's required reviews, checks and queue rules. Native stacks do not support
            auto-merge.
          </p>
          <ol aria-label="Stack layers" className="space-y-3">
            {stack.layers.map((layer) => (
              <li key={layer.number} className="border-l border-border pl-3 text-sm">
                <Button
                  aria-current={layer.number === ref.number ? "page" : undefined}
                  onClick={() => props.onOpen(layer.number)}
                >
                  Layer {layer.position}: #{layer.number} {layer.title}
                </Button>
                <p>
                  {layer.state} · {layer.baseBranch} ← {layer.branch} · head{" "}
                  {layer.headSha.slice(0, 12)}
                </p>
                <p>
                  Reported required checks:{" "}
                  {layer.requiredChecks
                    .map((check) => `${check.name}: ${check.state}`)
                    .join(" · ") || "None reported"}
                  {layer.checksTruncated ? " · More checks on GitHub" : ""}
                </p>
                <p>
                  Checks: {layer.checksState ?? "Unknown"} · Reviews:{" "}
                  {layer.reviewDecision ?? "Unknown"} · GitHub merge rules: {layer.mergeState}
                  {layer.queueState ? ` · Queue: ${layer.queueState}` : ""}
                </p>
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-2 text-sm">
            Stack task
            <Select
              label="Stack task"
              className="w-64"
              value={threadId}
              onValueChange={(value) => {
                setThread(value);
                setConfirmation(null);
              }}
              options={[
                { value: "", label: "Choose a linked task" },
                ...props.detail.relatedThreads.map((thread) => ({
                  value: thread.id,
                  label: thread.title,
                })),
              ]}
            />
          </div>
          {!associated && (
            <p className="text-sm">
              Link the selected PR to a task to use stack actions. Other layers keep their existing
              association choices.
            </p>
          )}
          {query.data?.localUnavailable && <p className="text-sm">{query.data.localUnavailable}</p>}
          {!canPublish && (
            <p className="text-sm">
              Queued, closed or unavailable layers must be reconciled on GitHub before publishing
              local branches.
            </p>
          )}
          <p className="text-sm">{stackPublicationUnavailable}</p>
          {operation && (
            <p role="status">
              {operation.state}: {operation.message}
            </p>
          )}
          <div className="flex items-center gap-2 text-sm">
            Stack merge method
            <Select
              label="Stack merge method"
              value={method}
              onValueChange={(value) => {
                setMethod(value);
                setConfirmation(null);
              }}
              options={[
                { value: "squash", label: "Squash" },
                { value: "merge", label: "Merge commit" },
                { value: "rebase", label: "Rebase" },
              ]}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                disabled ||
                !!incomplete ||
                !stack.canMerge ||
                scope.some((layer) => layer.state !== "OPEN" && layer.state !== "MERGED")
              }
              onClick={() => prepare("merge")}
            >
              Merge through #{ref.number}
            </Button>
            <Button
              disabled={disabled || !!incomplete || !canRebase || !canPublish}
              onClick={() => prepare("rebase")}
            >
              Rebase local stack
            </Button>
            {operation &&
              operation.action !== "merge" &&
              ["conflict", "uncertain"].includes(operation.state) && (
                <>
                  <Button
                    disabled={disabled || !canRecover || !canPublish}
                    onClick={() => prepare("continue")}
                  >
                    Continue local rebase
                  </Button>
                  <Button disabled={disabled || !canRecover} onClick={() => prepare("abort")}>
                    Abort rebase
                  </Button>
                </>
              )}
            {operation?.state === "push_partial" && (
              <Button disabled title={stackPublicationUnavailable}>
                Retry stack push
              </Button>
            )}
            <Button
              onClick={() =>
                void openExternal(props.detail.status.url).catch(() =>
                  setMessage("Couldn't open GitHub."),
                )
              }
            >
              Open stack on GitHub
            </Button>
          </div>
          {confirmation && (
            <div
              role="group"
              aria-label="Confirm stack action"
              className="space-y-2 rounded-md border border-border p-3"
            >
              <p>
                {confirmation.action === "merge"
                  ? `Merge ${confirmation.numbers.map((number) => `#${number}`).join(", ")} into ${confirmation.expected.trunk} using ${confirmation.method}. A merge queue chooses its own method.`
                  : `${confirmation.action === "abort" ? "Restore" : "Rebase"} local branches for ${confirmation.numbers.map((number) => `#${number}`).join(", ")}. No push will be attempted.`}
              </p>
              <p className="text-sm">
                ace checks every reviewed layer revision again before execution. GitHub makes the
                final merge decision.
              </p>
              <Button disabled={disabled} onClick={() => void run()}>
                Confirm {confirmation.action === "merge" ? "stack merge" : "stack action"}
              </Button>
              <Button disabled={pending} onClick={() => setConfirmation(null)}>
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
      {!stack && operation && (
        <p role="status">
          {operation.state}: {operation.message}
        </p>
      )}
      {!stack && query.data?.localUnavailable && <p>{query.data.localUnavailable}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
