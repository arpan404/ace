import { useState } from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useClient, useConnectionState } from "@ace/client-react";
import type { ForgePrDetail, ForgeStackMovedLayer, ForgeStackOperation } from "@ace/protocol";
import { stackPublishUpdates } from "@ace/forge/stack-publish";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { actionErrorText, stackConfirmation, stackControls } from "@ace/ui-core";
import { usePrStackQuery } from "./pr-stack-query.ts";
import { QueryState } from "./query-state.tsx";
import { StackRail } from "./pr-stack-rail.tsx";
import { StackConfirm } from "./pr-stack-confirm.tsx";
import type { StackConfirmation } from "@ace/ui-core";
import { stackOperationLabel } from "@ace/ui-core";

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

/** States whose daemon message is the reason the person has to act on. */
const explainedStates = new Set<ForgeStackOperation["state"]>(["failed", "uncertain", "conflict"]);

function OperationStatus(props: { operation: ForgeStackOperation }) {
  const label = stackOperationLabel(props.operation);
  return (
    <p role="status" className="text-ui">
      {explainedStates.has(props.operation.state) ? `${label} · ${props.operation.message}` : label}
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
  const openWeb = useOpenWebAddress();
  const ready = useConnectionState() === "ready";
  const ref = props.detail.status.ref;
  const [threadId, setThread] = useState(props.detail.relatedThreads[0]?.id ?? "");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [confirmation, setConfirmation] = useState<StackConfirmation | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const query = usePrStackQuery({ workspaceId: props.workspaceId, pr: ref, threadId });
  const stack = query.isError ? undefined : (query.data?.stack ?? undefined);
  const operation = query.data?.operation;
  const moved = (!query.isError && query.data?.movedLayers) || [];
  const associated = props.detail.relatedThreads.some((thread) => thread.id === threadId);
  const busy = !ready || pending || query.isFetching || query.isError || !stack;
  const disabled = busy || !associated;
  const controls = stackControls({
    workspace: query.isError ? undefined : query.data,
    number: ref.number,
    associated,
    busy,
  });
  const publishing =
    confirmation?.action === "push" ? stackPublishUpdates(confirmation.expected) : [];
  const prepare = (action: StackConfirmation["action"]) => {
    if (!query.data || disabled) return;
    setConfirmation(stackConfirmation(query.data, ref.number, action, method) ?? null);
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
            : actionErrorText(receipt.error ?? "action_failed")),
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
  return (
    <section aria-label="Pull request stack" className="space-y-2">
      <div className="flex items-center gap-1">
        <h3 className="text-ui font-medium text-muted-foreground">
          {stack ? `Stack #${stack.number} → ${stack.trunk}` : "Stack"}
        </h3>
        <span className="ml-auto text-xs text-subtle-foreground">
          {query.isFetching ? "Refreshing…" : query.isError ? "May be stale" : ""}
        </span>
        {stack && (
          <IconButton
            icon={ArrowSquareOutIcon}
            size="sm"
            label="Open stack on GitHub"
            onClick={(event) =>
              void openWeb(props.detail.status.url, event).catch(() =>
                setMessage("Couldn't open GitHub."),
              )
            }
          />
        )}
      </div>
      {/* Background refreshes keep the rail in place; only a first read, error or offline shows. */}
      {!(query.data && !query.isError && ready) && <QueryState label="stack" query={query} />}
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
          {controls.map((control) => (
            <StackAction
              key={control.action}
              reason={control.reason}
              onClick={() => prepare(control.action)}
            >
              {control.label}
            </StackAction>
          ))}
        </div>
      )}
      {stack && confirmation && (
        <StackConfirm
          confirmation={confirmation}
          publishing={publishing}
          moved={moved}
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
