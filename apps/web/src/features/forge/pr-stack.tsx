import { useState } from "react";
import { ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useClient, useConnectionState } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import type { ForgePrDetail, ForgeStackMovedLayer, ForgeStackOperation } from "@ace/protocol";
import { canPublishStack, matchesLocalStack, matchesStackBranches } from "@ace/forge/stack-plan";
import { canPublishAfter, stackPublishUpdates } from "@ace/forge/stack-publish";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { Select } from "@/components/ui/select.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { readForge, forgeError } from "./source.ts";
import { QueryState } from "./query-state.tsx";
import { StackRail } from "./pr-stack-rail.tsx";
import { StackConfirm, type StackConfirmation } from "./pr-stack-confirm.tsx";
import { stackOperationLabel } from "./pr-stack-labels.ts";

/** One action in the stack toolbar; while disabled its reason is a hover/focus tip. */
function StackAction(props: { reason: string | undefined; onClick(): void; children: string }) {
  return (
    <DisabledReason reason={props.reason}>
      <Button size="sm" disabled={props.reason !== undefined} onClick={props.onClick}>
        {props.children}
      </Button>
    </DisabledReason>
  );
}

function OperationStatus(props: { operation: ForgeStackOperation }) {
  return (
    <p role="status" className="text-ui">
      {`${stackOperationLabel(props.operation)} · ${props.operation.message}`}
    </p>
  );
}

/** Layers a collaborator moved on GitHub after review: the reviewed head and GitHub's head now. */
function MovedLayers(props: { moved: readonly ForgeStackMovedLayer[] }) {
  return (
    <div className="space-y-1 text-ui">
      <p className="text-status-needs-you">Moved on GitHub since review</p>
      <ul aria-label="Layers moved on GitHub" className="font-mono text-sm">
        {props.moved.map((layer) => (
          <li key={layer.number}>
            #{layer.number} {layer.branch} {layer.reviewed.slice(0, 7)} →{" "}
            {layer.current.slice(0, 7)}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const [confirmation, setConfirmation] = useState<StackConfirmation | null>(null);
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
  const stack = query.isError ? undefined : (query.data?.stack ?? undefined);
  const local = query.data?.local;
  const operation = query.data?.operation;
  const moved = (!query.isError && query.data?.movedLayers) || [];
  const index = stack?.layers.findIndex((layer) => layer.number === ref.number) ?? -1;
  const scope = stack?.layers.slice(0, index + 1) ?? [];
  const incomplete =
    operation && ["pending", "uncertain", "conflict", "push_partial"].includes(operation.state);
  const associated = props.detail.relatedThreads.some((thread) => thread.id === threadId);
  const busy = !ready || pending || query.isFetching || query.isError || !stack;
  const disabled = busy || !associated;
  const canRebase =
    stack && local && !query.data?.localUnavailable && matchesLocalStack(local, stack);
  const canRecover =
    stack && local && !query.data?.localUnavailable && matchesStackBranches(local, stack);
  const canPublish =
    stack &&
    canPublishStack(stack) &&
    stack.layers.every((layer) => layer.queueState === null) &&
    !local?.branches.some((branch) => branch.isQueued);
  const publishing =
    confirmation?.action === "push" ? stackPublishUpdates(confirmation.expected) : [];
  // Why a toolbar action can't run now, checked in the order the person can fix them.
  const writeReason = !associated
    ? "Link this pull request to a task first."
    : busy
      ? "Wait for the stack to refresh."
      : undefined;
  const localReason =
    writeReason ??
    query.data?.localUnavailable ??
    (!canPublish ? "Reconcile queued, closed or unavailable layers on GitHub first." : undefined);
  const busyReason = incomplete
    ? "Finish or reconcile the current stack operation first."
    : undefined;
  const mergeReason =
    writeReason ??
    busyReason ??
    (!stack?.canMerge
      ? "GitHub doesn't allow merging this stack."
      : scope.some((layer) => layer.state !== "OPEN" && layer.state !== "MERGED")
        ? "A lower layer is closed."
        : undefined);
  const rebaseReason =
    localReason ??
    busyReason ??
    (!canRebase ? "The task checkout doesn't match this stack." : undefined);
  const recoverReason =
    localReason ?? (!canRecover ? "The task checkout doesn't match this stack." : undefined);
  const abortReason =
    writeReason ??
    query.data?.localUnavailable ??
    (!canRecover ? "The task checkout doesn't match this stack." : undefined);
  const recovering =
    operation &&
    operation.action !== "merge" &&
    operation.action !== "push" &&
    ["conflict", "uncertain"].includes(operation.state);
  const prepare = (action: StackConfirmation["action"]) => {
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
  // A PR outside any native stack, with nothing to recover, shows no section at all.
  const loadedEmpty = !!query.data && !query.isError && !stack && !operation;
  if ((!query.data && !query.error) || (loadedEmpty && !message)) return null;
  const refresh = (
    <IconButton
      icon={ArrowClockwiseIcon}
      size="sm"
      className="ml-auto"
      label="Refresh stack"
      disabled={!ready || pending || query.isFetching}
      onClick={() => void query.refetch()}
    />
  );
  return (
    <section aria-label="Pull request stack" className="space-y-2">
      <div className="flex items-center gap-1">
        <h3 className="text-ui font-medium text-muted-foreground">
          {stack ? `Stack #${stack.number} → ${stack.trunk}` : "Stack"}
        </h3>
        {refresh}
        {stack && (
          <IconButton
            icon={ArrowSquareOutIcon}
            size="sm"
            label="Open stack on GitHub"
            onClick={() =>
              void openExternal(props.detail.status.url).catch(() =>
                setMessage("Couldn't open GitHub."),
              )
            }
          />
        )}
      </div>
      {/* Background refreshes keep the rail in place; only a first read, error or offline shows. */}
      {!(query.data && !query.isError && ready) && <QueryState query={query} />}
      {stack && <StackRail layers={stack.layers} current={ref.number} onOpen={props.onOpen} />}
      {operation && <OperationStatus operation={operation} />}
      {moved.length > 0 && <MovedLayers moved={moved} />}
      {stack && (
        <div
          role="group"
          aria-label="Stack actions"
          className="flex flex-wrap items-center gap-1.5"
        >
          {props.detail.relatedThreads.length > 1 && (
            <Select
              label="Stack task"
              className="h-6.5 w-44 text-sm"
              value={threadId}
              onValueChange={(value) => {
                setThread(value);
                setConfirmation(null);
              }}
              options={props.detail.relatedThreads.map((thread) => ({
                value: thread.id,
                label: thread.title,
              }))}
            />
          )}
          {!props.detail.relatedThreads.length && (
            <span className="text-ui text-muted-foreground">No linked task</span>
          )}
          <Select
            label="Stack merge method"
            className="h-6.5 w-32 text-sm"
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
          <StackAction reason={mergeReason} onClick={() => prepare("merge")}>
            {`Merge through #${ref.number}`}
          </StackAction>
          <StackAction reason={rebaseReason} onClick={() => prepare("rebase")}>
            Rebase local stack
          </StackAction>
          {recovering && (
            <>
              <StackAction reason={recoverReason} onClick={() => prepare("continue")}>
                Continue local rebase
              </StackAction>
              <StackAction reason={abortReason} onClick={() => prepare("abort")}>
                Abort rebase
              </StackAction>
            </>
          )}
          {operation && canPublishAfter(operation) && (
            <StackAction
              reason={
                recoverReason ??
                (moved.length
                  ? "GitHub has newer commits on some layers. Bring them into the stack with gh stack, then rebase again."
                  : undefined)
              }
              onClick={() => prepare("push")}
            >
              Publish stack
            </StackAction>
          )}
        </div>
      )}
      {stack && confirmation && (
        <StackConfirm
          confirmation={confirmation}
          publishing={publishing}
          disabled={disabled}
          pending={pending}
          onConfirm={() => void run()}
          onCancel={() => setConfirmation(null)}
        />
      )}
      {!stack && query.data?.localUnavailable && operation && (
        <p className="text-ui">{query.data.localUnavailable}</p>
      )}
      {message && (
        <p role="status" className="text-ui">
          {message}
        </p>
      )}
    </section>
  );
}
