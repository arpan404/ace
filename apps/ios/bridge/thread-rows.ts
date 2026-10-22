import type { ThreadSource } from "@ace/client";
import type { Item } from "@ace/protocol";
import {
  describeStep,
  handoffMarker,
  opensAgentPage,
  shownStep,
  stepGlyphKind,
  stepLabels,
  stepOpens,
  type StepContext,
} from "@ace/ui-core";
import { preview } from "./presentation.ts";
import { stepDetail } from "./step-detail.ts";
import { bubbleOf } from "./thread-messages.ts";

/*
 * What a transcript row shows beyond its text: a step's one-line wording (shared with the web's
 * work log), attachment placeholders, and whether a message is an injected event. Display text
 * is bounded; identities stay exact. Pure over the item.
 */

const attachmentLimit = 8;

/**
 * Where tapping a step goes: `device:<id>` for a simulator or emulator step that names its
 * device, `computer` for a computer-use step; empty otherwise.
 */
function opensOf(ace: ReturnType<typeof describeStep>["ace"]): string {
  if (ace?.family === "screen") return "computer";
  const key = ace?.family === "device" ? ace.subject?.key : undefined;
  return key?.startsWith("device:") && key.length > 7 ? key : "";
}

/**
 * What a step reads with beyond its item: paths relative to where its agent works, and the
 * approval that gated it (the newest offered for the call).
 */
export function stepContext(store: ThreadSource, item: Item): StepContext {
  const cwd = item.agentId ? store.agent(item.agentId)?.cwd : undefined;
  if (item.type !== "tool_call") return { cwd };
  let interaction;
  for (const id of store.interactionIds()) {
    const candidate = store.interaction(id);
    if (candidate?.toolCallId === item.id && candidate.request.kind === "approval")
      interaction = candidate;
  }
  return { cwd, interaction };
}

/** The step line for tools, thinking and notices, as the web's step row reads it. */
export function stepOf(item: Item, context: Omit<StepContext, "labels"> = {}) {
  if (item.type !== "tool_call" && item.type !== "reasoning" && item.type !== "notice") return null;
  const { step, awaiting } = shownStep(
    item,
    describeStep(item, { ...context, labels: stepLabels }),
  );
  const family = step.ace?.family;
  return {
    icon: family === "device" ? "device" : family === "screen" ? "computer" : step.icon,
    /** What the row's glyph shows, as the web's step glyph picks it. */
    glyph: stepGlyphKind(item, step.ace?.mark),
    opens: opensOf(step.ace),
    verb: preview(step.verb, 256),
    target: preview(step.target ?? "", 512),
    note: preview(step.note === "Waiting for your approval" ? "" : (step.note ?? ""), 128),
    settled: step.settled,
    failed: step.failed,
    needsYou: step.needsYou === true,
    /** Waits on an approval nobody has answered: the row steps aside for the composer's request. */
    awaiting,
    /** The row opens to its output, diff or reasoning. */
    expandable: stepOpens(item),
    /** What the opened row shows, bounded. */
    detail: stepOpens(item) ? stepDetail(item, context) : null,
    added: step.added ?? null,
    removed: step.removed ?? null,
    /** An agent opened a page in the thread's browser: the row opens the browser. */
    browser: opensAgentPage(item),
  };
}

/** Images and files carried by a message, shown as placeholders on the phone. */
function attachmentsOf(item: Item) {
  if (item.type !== "message") return { attachments: [], moreAttachments: 0 };
  const shown: { kind: string; name: string }[] = [];
  for (const part of item.parts)
    if (part.type === "image") shown.push({ kind: "image", name: preview(part.mimeType, 128) });
    else if (part.type === "file")
      shown.push({
        kind: "file",
        name: preview(part.name ?? part.path.split("/").at(-1) ?? "", 128),
      });
  for (const attachment of item.attachments ?? [])
    shown.push({ kind: attachment.kind ?? "binary", name: preview(attachment.name, 128) });
  return {
    attachments: shown.slice(0, attachmentLimit),
    moreAttachments: Math.max(0, shown.length - attachmentLimit),
  };
}

/** A context handoff's divider: the models whose work carried over and the one taking it. */
function handoffOf(item: Item) {
  const marker = item.type === "message" && item.role === "user" ? handoffMarker(item) : undefined;
  if (!marker) return null;
  const end = (side: (typeof marker)["to"]) => ({
    provider: side.provider,
    model: preview(side.model ?? "", 256),
    name: preview(side.name, 128),
  });
  return {
    label: marker.label,
    from: marker.from.slice(0, 8).map(end),
    to: end(marker.to),
    text: preview(marker.text, 512),
  };
}

export function itemDetail(item: Item, context?: StepContext) {
  return {
    handoff: handoffOf(item),
    runId: item.runId ?? "",
    synthetic: item.type === "message" && item.synthetic === true,
    level: item.type === "notice" ? item.level : "",
    step: stepOf(item, context),
    bubble: bubbleOf(item),
    ...attachmentsOf(item),
  };
}
