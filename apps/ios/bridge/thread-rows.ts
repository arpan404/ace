import type { Item } from "@ace/protocol";
import { describeStep, handoffMarker, opensAgentPage, stepLabels } from "@ace/ui-core";
import { preview } from "./presentation.ts";
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

/** The step line for tools, thinking and notices: "Ran `bun test`  exit 0". */
function stepOf(item: Item) {
  if (item.type !== "tool_call" && item.type !== "reasoning" && item.type !== "notice") return null;
  const step = describeStep(item, { labels: stepLabels });
  const family = step.ace?.family;
  return {
    icon: family === "device" ? "device" : family === "screen" ? "computer" : step.icon,
    opens: opensOf(step.ace),
    verb: preview(step.verb, 256),
    target: preview(step.target ?? "", 512),
    note: preview(step.note ?? "", 128),
    settled: step.settled,
    failed: step.failed,
    needsYou: step.needsYou === true,
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

export function itemDetail(item: Item) {
  return {
    handoff: handoffOf(item),
    runId: item.runId ?? "",
    synthetic: item.type === "message" && item.synthetic === true,
    level: item.type === "notice" ? item.level : "",
    step: stepOf(item),
    bubble: bubbleOf(item),
    ...attachmentsOf(item),
  };
}
