import type { ForgeStack, ForgeStackExpected, ForgeStackOperation } from "@ace/protocol";

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
  const index = expected.layers.findIndex((layer) => layer.number === number);
  const members = new Map(stack.layers.map((layer) => [layer.number, layer]));
  const scope =
    index < 0 ? [] : expected.layers.slice(0, index + 1).map((layer) => members.get(layer.number));
  if (expected.id !== stack.id || !scope.length || scope.some((layer) => !layer)) {
    return operation.state === "enqueued"
      ? {
          ...operation,
          state: "failed",
          message:
            "GitHub changed the requested stack membership. Inspect the current layers and queue before another merge request.",
        }
      : operation;
  }
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
