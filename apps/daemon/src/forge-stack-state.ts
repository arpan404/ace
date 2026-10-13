import type {
  ForgeStack,
  ForgeStackExpected,
  ForgeStackLayer,
  ForgeStackOperation,
} from "@ace/protocol";
import { reconcileStackPublication, stackPublishUpdates } from "@ace/forge";

/** Settle a recorded publication from GitHub's layer heads, never by repeating the push. */
export function reconcileStackPush(
  operation: ForgeStackOperation,
  expected: ForgeStackExpected,
  stack: ForgeStack,
): ForgeStackOperation {
  if (
    operation.action !== "push" ||
    !["uncertain", "push_partial"].includes(operation.state) ||
    expected.id !== stack.id
  )
    return operation;
  const result = reconcileStackPublication(stackPublishUpdates(expected), stack);
  if (result === "published")
    return {
      ...operation,
      state: "rebased",
      message: "GitHub reports every layer at the published revision.",
    };
  if (result === "unpublished" && operation.state === "uncertain")
    return {
      ...operation,
      state: "push_partial",
      message:
        "GitHub still has the reviewed revisions. Nothing was published; publish again when ready.",
    };
  if (result === "unknown" && operation.state === "push_partial")
    return {
      ...operation,
      state: "uncertain",
      message: "GitHub reports some layers at other revisions. Inspect them before publishing.",
    };
  return operation;
}

/** A local rebase waiting to be published, or a publication GitHub refused or never confirmed. */
export function awaitsPublication(operation: ForgeStackOperation): boolean {
  return (
    operation.action !== "merge" &&
    (operation.state === "push_partial" ||
      (operation.action === "push" && ["failed", "uncertain"].includes(operation.state)))
  );
}

export function isIncompleteStackOperation(operation: ForgeStackOperation): boolean {
  return ["pending", "uncertain", "conflict", "push_partial"].includes(operation.state);
}

/** Reconcile the original requested scope, even if GitHub has changed its entries. */
export function reconcileStackMerge(
  operation: ForgeStackOperation,
  expected: ForgeStackExpected,
  number: number,
  stack: ForgeStack,
): ForgeStackOperation {
  if (
    operation.action !== "merge" ||
    (operation.state !== "enqueued" && operation.state !== "uncertain")
  )
    return operation;
  if (expected.id !== stack.id) return operation;
  return reconcileRecordedStackMerge(operation, expected, number, stack.layers);
}

export function requestedStackScope(expected: ForgeStackExpected, number: number) {
  const index = expected.layers.findIndex((layer) => layer.number === number);
  return index < 0 ? [] : expected.layers.slice(0, index + 1);
}

export function reconcileRecordedStackMerge(
  operation: ForgeStackOperation,
  expected: ForgeStackExpected,
  number: number,
  layers: readonly Pick<ForgeStackLayer, "number" | "state" | "queueState">[],
): ForgeStackOperation {
  if (operation.action !== "merge" || !["enqueued", "uncertain"].includes(operation.state))
    return operation;
  const members = new Map(layers.map((layer) => [layer.number, layer]));
  const scope = requestedStackScope(expected, number).map((layer) => members.get(layer.number));
  if (!scope.length || scope.some((layer) => !layer))
    return {
      ...operation,
      state: "uncertain",
      message:
        "GitHub could not resolve every PR in the recorded merge scope. Inspect their queue state before another request.",
    };
  if (scope.every((layer) => layer?.state === "MERGED"))
    return {
      ...operation,
      state: "merged",
      message: "GitHub reports all requested layers merged.",
    };
  if (
    operation.state === "enqueued" &&
    scope.some((layer) => layer?.state !== "MERGED" && layer?.queueState === null)
  )
    return {
      ...operation,
      state: "failed",
      message:
        "GitHub no longer reports all requested layers queued. Inspect current blockers before another merge request.",
    };
  if (
    operation.state === "uncertain" &&
    scope.every((layer) => layer?.state === "MERGED" || layer?.queueState !== null)
  )
    return {
      ...operation,
      state: "enqueued",
      message: "GitHub's current layer states confirm the earlier request.",
    };
  return operation;
}
