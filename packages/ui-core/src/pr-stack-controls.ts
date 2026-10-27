import type { ForgeStackExpected, ForgeStackOperation, ForgeStackWorkspace } from "@ace/protocol";
import { canPublishStack, matchesLocalStack, matchesStackBranches } from "@ace/forge/stack-plan";
import { canPublishAfter, stackPublishUpdates } from "@ace/forge/stack-publish";

/*
 * What a pull request's stack lets the person do now, and why not when it doesn't: the web's
 * stack toolbar and the phone's stack page both draw these. Pure.
 */

export type StackAction = ForgeStackOperation["action"];
export type StackMethod = "merge" | "squash" | "rebase";

/** One control: shown or not, and the reason it can't be pressed now (undefined when it can). */
export interface StackControl {
  action: StackAction;
  label: string;
  reason: string | undefined;
}

export interface StackFacts {
  workspace: ForgeStackWorkspace | undefined;
  /** The pull request whose page this is. */
  number: number;
  /** The thread chosen to run stack changes is linked to this pull request. */
  associated: boolean;
  /** Offline, a write in flight, or the stack still being read. */
  busy: boolean;
}

/** Operation states that leave the stack half done until finished or reconciled. */
const incompleteStates = new Set<ForgeStackOperation["state"]>([
  "pending",
  "uncertain",
  "conflict",
  "push_partial",
]);

/** The layers up to and including this pull request: what "Merge through" merges. */
function scopeOf(workspace: ForgeStackWorkspace | undefined, number: number) {
  const layers = workspace?.stack?.layers ?? [];
  const index = layers.findIndex((layer) => layer.number === number);
  return layers.slice(0, index + 1);
}

/** The stack's controls in toolbar order; only those that apply now are listed. */
export function stackControls(facts: StackFacts): StackControl[] {
  const { workspace, number } = facts;
  const stack = workspace?.stack ?? undefined;
  if (!stack) return [];
  const local = workspace?.local ?? undefined;
  const operation = workspace?.operation ?? undefined;
  const moved = workspace?.movedLayers ?? [];
  const localUnavailable = workspace?.localUnavailable ?? undefined;
  const scope = scopeOf(workspace, number);
  const incomplete = operation !== undefined && incompleteStates.has(operation.state);
  const canRebase = local && !localUnavailable && matchesLocalStack(local, stack);
  const canRecover = local && !localUnavailable && matchesStackBranches(local, stack);
  const canPublish =
    canPublishStack(stack) &&
    stack.layers.every((layer) => layer.queueState === null) &&
    !local?.branches.some((branch) => branch.isQueued);
  // Checked in the order the person can fix them.
  const writeReason = !facts.associated
    ? "Link this pull request to a thread first."
    : facts.busy
      ? "Wait for the stack to refresh."
      : undefined;
  const localReason =
    writeReason ??
    localUnavailable ??
    (!canPublish ? "Reconcile queued, closed or unavailable layers on GitHub first." : undefined);
  const busyReason = incomplete
    ? "Finish or reconcile the current stack operation first."
    : undefined;
  const mismatch = "The thread's checkout doesn't match this stack.";
  const recoverReason = localReason ?? (!canRecover ? mismatch : undefined);
  const controls: StackControl[] = [
    {
      action: "merge",
      label: `Merge through #${number}`,
      reason:
        writeReason ??
        busyReason ??
        (!stack.canMerge
          ? "GitHub doesn't allow merging this stack."
          : scope.some((layer) => layer.state !== "OPEN" && layer.state !== "MERGED")
            ? "A lower layer is closed."
            : undefined),
    },
    {
      action: "rebase",
      label: "Rebase local stack",
      reason: localReason ?? busyReason ?? (!canRebase ? mismatch : undefined),
    },
  ];
  const recovering =
    operation &&
    operation.action !== "merge" &&
    operation.action !== "push" &&
    (operation.state === "conflict" || operation.state === "uncertain");
  const syncing = operation?.action === "sync";
  if (recovering) {
    // A sync interrupted without a result can only be restored, not continued.
    if (!(syncing && operation.state === "uncertain"))
      controls.push({
        action: "continue",
        label: syncing ? "Continue sync" : "Continue local rebase",
        reason: recoverReason,
      });
    controls.push({
      action: "abort",
      label: syncing ? "Abort sync" : "Abort rebase",
      reason: writeReason ?? localUnavailable ?? (!canRecover ? mismatch : undefined),
    });
  }
  if (moved.length)
    controls.push({ action: "sync", label: "Bring in GitHub commits", reason: recoverReason });
  if (operation && canPublishAfter(operation))
    controls.push({
      action: "push",
      label: "Publish stack",
      reason:
        recoverReason ??
        (moved.length
          ? "GitHub has newer commits on some layers. Bring them into the stack first."
          : undefined),
    });
  return controls;
}

/** What a confirmed stack change names: the stack as reviewed, and the layers it touches. */
export interface StackConfirmation {
  action: StackAction;
  method: StackMethod;
  expected: ForgeStackExpected;
  numbers: number[];
}

/** The review a stack change is confirmed against, made from the stack shown. */
export function stackConfirmation(
  workspace: ForgeStackWorkspace,
  number: number,
  action: StackAction,
  method: StackMethod,
): StackConfirmation | undefined {
  const stack = workspace.stack;
  if (!stack) return undefined;
  const numbers = (
    action === "merge"
      ? scopeOf(workspace, number)
      : action === "sync"
        ? workspace.movedLayers
        : stack.layers.filter((layer) => layer.state !== "MERGED")
  ).map((layer) => layer.number);
  return {
    action,
    method,
    numbers,
    expected: {
      id: stack.id,
      trunk: stack.trunk,
      layers: stack.layers.map((layer) => ({ number: layer.number, headSha: layer.headSha })),
      local: workspace.local ?? null,
    },
  };
}

const numbered = (numbers: readonly number[]) => numbers.map((number) => `#${number}`).join(", ");
const short = (sha: string) => sha.slice(0, 7);

/**
 * What a stack change will do, in words, and the lines it lists (old → new revisions), shown
 * before it is confirmed. `ready` is false when there is nothing for it to do.
 */
export function stackConfirmationText(
  confirmation: StackConfirmation,
  moved: Readonly<ForgeStackWorkspace["movedLayers"]>,
): { text: string; lines: string[]; confirm: string; ready: boolean } {
  if (confirmation.action === "push") {
    const updates = stackPublishUpdates(confirmation.expected);
    return {
      text: "Push to origin together, leased to the reviewed revisions:",
      lines: updates.map(
        (update) =>
          `#${update.number} ${update.branch} ${short(update.lease)} → ${short(update.target)}`,
      ),
      confirm: "Push the stack",
      ready: updates.length > 0,
    };
  }
  if (confirmation.action === "sync")
    return {
      text: "Fetch GitHub's newer commits, replay them onto these local layers and restack the layers above. Nothing is pushed until you publish, which then leases each layer to the head GitHub reports now:",
      lines: moved.map(
        (layer) =>
          `#${layer.number} ${layer.branch} ${short(layer.reviewed)}..${short(layer.current)}`,
      ),
      confirm: "Bring in GitHub commits",
      ready: moved.length > 0,
    };
  return {
    text:
      confirmation.action === "merge"
        ? `Merge ${numbered(confirmation.numbers)} into ${confirmation.expected.trunk} using ${confirmation.method}. A merge queue chooses its own method.`
        : `${confirmation.action === "abort" ? "Restore" : "Rebase"} local branches for ${numbered(confirmation.numbers)}. Nothing is pushed until you publish.`,
    lines: [],
    // The button names what happens, as every confirming button does.
    confirm:
      confirmation.action === "merge"
        ? "Merge the stack"
        : confirmation.action === "abort"
          ? "Restore local branches"
          : "Rebase local branches",
    ready: true,
  };
}
