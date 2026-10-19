import type { Item } from "@ace/protocol";
import { describeStep, stepLabels } from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * What a transcript row shows beyond its text: a step's one-line wording (shared with the web's
 * work log), attachment placeholders, and whether a message is an injected event. Display text
 * is bounded; identities stay exact. Pure over the item.
 */

const attachmentLimit = 8;

/** The step line for tools, thinking and notices: "Ran `bun test`  exit 0". */
function stepOf(item: Item) {
  if (item.type !== "tool_call" && item.type !== "reasoning" && item.type !== "notice") return null;
  const step = describeStep(item, { labels: stepLabels });
  return {
    icon: step.icon,
    verb: preview(step.verb, 256),
    target: preview(step.target ?? "", 512),
    note: preview(step.note ?? "", 128),
    settled: step.settled,
    failed: step.failed,
    needsYou: step.needsYou === true,
    added: step.added ?? null,
    removed: step.removed ?? null,
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

export function itemDetail(item: Item) {
  return {
    runId: item.runId ?? "",
    synthetic: item.type === "message" && item.synthetic === true,
    level: item.type === "notice" ? item.level : "",
    step: stepOf(item),
    ...attachmentsOf(item),
  };
}
