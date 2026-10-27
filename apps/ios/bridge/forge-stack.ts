import {
  ForgeRepository,
  ForgeStackExpected,
  ThreadId,
  type ForgeStackOperation,
  type ForgeStackWorkspace,
} from "@ace/protocol";
import {
  actionErrorText,
  layerChecksSignal,
  layerMergeBlocker,
  layerStateLabel,
  reviewSignal,
  stackConfirmation,
  stackConfirmationText,
  stackControls,
  stackOperationLabel,
  type StackSignal,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { prDetail, scopeOf } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";

/*
 * A pull request's stack (GitHub's native stacked PRs) as the phone's stack page shows it: its
 * layers in order, the operation in flight, and the controls the web's stack toolbar offers,
 * each with why it can't run now. A change is confirmed against the stack as shown (its
 * `review`), runs through a linked thread's checkout, and is sent once.
 */

const method = z.enum(["merge", "squash", "rebase"]);
const target = {
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
  threadId: z.string().min(1).max(256).optional(),
};
export const ForgeStackRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forge.pull.stack"), ...target, method: method.default("squash") }),
  z.object({
    type: z.literal("forge.stack"),
    ...target,
    repository: ForgeRepository,
    threadId: z.string().min(1).max(256),
    action: z.enum(["merge", "rebase", "continue", "abort", "push", "sync"]),
    method,
    /** The stack as reviewed, from the page's confirmation (`StackReply.controls[].review`). */
    review: z.string().min(2).max(200_000),
  }),
]);
export type ForgeStackRequest = z.infer<typeof ForgeStackRequest>;

const tones: Record<StackSignal, string> = {
  good: "done",
  pending: "working",
  bad: "failed",
  unknown: "idle",
};
/** States whose daemon message is the reason the person has to act on. */
const explained = new Set<ForgeStackOperation["state"]>(["failed", "uncertain", "conflict"]);

export interface StackReply {
  type: "forge.pull.stack";
  threads: { id: string; title: string }[];
  threadId: string | null;
  /** Null for a pull request outside any stack. */
  stack: {
    number: number;
    trunk: string;
    layers: {
      number: number;
      title: string;
      branch: string;
      state: string;
      checks: { label: string; tone: string };
      review: { label: string; tone: string };
      merge: { label: string; blocked: boolean };
      current: boolean;
    }[];
  } | null;
  operation: { label: string; tone: string } | null;
  moved: string[];
  note: string | null;
  controls: {
    action: ForgeStackOperation["action"];
    label: string;
    reason: string | null;
    /** What confirming it does, in words and lines, and the stack review it names. */
    confirm: {
      text: string;
      lines: string[];
      button: string;
      ready: boolean;
      review: string;
    } | null;
  }[];
}

export async function readStack(
  reads: ForgeReads,
  request: Extract<ForgeStackRequest, { type: "forge.pull.stack" }>,
  preview: Preview,
): Promise<StackReply> {
  const detail = await prDetail(reads, request);
  const threads = detail.relatedThreads.filter((thread) => !thread.archived);
  const threadId = threads.find((thread) => thread.id === request.threadId)?.id ?? threads[0]?.id;
  const value = await reads.read(
    {
      op: "forge.pr.stack",
      ...scopeOf(request),
      ...(threadId ? { threadId: ThreadId.parse(threadId) } : {}),
    },
    false,
  );
  if (value.resource !== "prStack") throw new ForgeRefusal("forge_invalid_data");
  const workspace = value.value;
  const stack = workspace.stack;
  const operation = workspace.operation;
  const controls = stackControls({
    workspace,
    number: request.number,
    associated: threadId !== undefined,
    busy: false,
  });
  return {
    type: "forge.pull.stack",
    threads: threads.map((thread) => ({ id: thread.id, title: preview(thread.title, 200) })),
    threadId: threadId ?? null,
    stack: stack
      ? {
          number: stack.number,
          trunk: preview(stack.trunk, 256),
          layers: stack.layers.map((layer) => {
            const checks = layerChecksSignal(layer);
            const review = reviewSignal(layer.reviewDecision);
            return {
              number: layer.number,
              title: preview(layer.title, 300),
              branch: preview(layer.branch, 256),
              state: layerStateLabel(layer.state),
              checks: { label: checks.label, tone: tones[checks.signal] },
              review: { label: review.label, tone: tones[review.signal] },
              merge: layerMergeBlocker(layer),
              current: layer.number === request.number,
            };
          }),
        }
      : null,
    operation: operation
      ? {
          label: explained.has(operation.state)
            ? `${stackOperationLabel(operation)} · ${preview(operation.message, 2_000)}`
            : stackOperationLabel(operation),
          tone: explained.has(operation.state) ? "failed" : "idle",
        }
      : null,
    moved: workspace.movedLayers.map(
      (layer) =>
        `#${layer.number} ${layer.branch} ${layer.reviewed.slice(0, 7)} → ${layer.current.slice(0, 7)}`,
    ),
    note: !stack && operation ? (workspace.localUnavailable ?? null) : null,
    controls: controls.map((control) => ({
      action: control.action,
      label: control.label,
      reason: control.reason ?? null,
      confirm: confirmOf(workspace, request.number, control.action, request.method),
    })),
  };
}

function confirmOf(
  workspace: ForgeStackWorkspace,
  number: number,
  action: ForgeStackOperation["action"],
  chosen: "merge" | "squash" | "rebase",
): StackReply["controls"][number]["confirm"] {
  const confirmation = stackConfirmation(workspace, number, action, chosen);
  if (!confirmation) return null;
  const words = stackConfirmationText(confirmation, workspace.movedLayers);
  return {
    text: words.text,
    lines: words.lines,
    button: words.confirm,
    ready: words.ready,
    review: JSON.stringify(confirmation.expected),
  };
}

export interface StackWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  uncertain: boolean;
}

export async function writeStack(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Extract<ForgeStackRequest, { type: "forge.stack" }>,
): Promise<StackWriteReply> {
  const parsed = ForgeStackExpected.safeParse(
    (() => {
      try {
        return JSON.parse(request.review) as unknown;
      } catch {
        return undefined;
      }
    })(),
  );
  if (!parsed.success)
    return {
      type: "forge.write",
      ok: false,
      message: actionErrorText("invalid"),
      uncertain: false,
    };
  try {
    const receipt = await owner.command({
      type: "forge.pr.stack.change",
      link: {
        threadId: ThreadId.parse(request.threadId),
        pr: { repository: request.repository, number: request.number },
      },
      expected: parsed.data,
      action: request.action,
      method: request.method,
    });
    reads.forget(request.project);
    return {
      type: "forge.write",
      ok: receipt.ok,
      message:
        receipt.stackOperation?.message ??
        (receipt.ok
          ? "GitHub acknowledged the operation. Refreshing the stack."
          : actionErrorText(receipt.error ?? "action_failed")),
      uncertain: receipt.stackOperation?.state === "uncertain",
    };
  } catch {
    reads.forget(request.project);
    return {
      type: "forge.write",
      ok: false,
      message:
        "The acknowledgement was lost. Refresh the stack to reconcile the operation before recovery.",
      uncertain: true,
    };
  }
}
