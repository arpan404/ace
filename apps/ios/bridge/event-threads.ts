import type { EventView } from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * The event rows that point at another thread, flattened for Swift as the web draws them: a
 * task card (a handoff's or an automation's prompt, `TaskCard`) whose handoff links back to the
 * thread it came from, and a merged fork's line ("Merged from" the fork, `MergedForkNotice`).
 * `threadId` is the thread the row's chip opens; Swift titles it from the thread list.
 */

type ThreadEvent = Extract<EventView, { kind: "task" | "merged" }>;

export function threadEventRow(view: ThreadEvent) {
  if (view.kind === "task")
    return {
      /** "Handoff", "Automation". */
      text: preview(view.prompt.label, 128),
      note: preview(view.prompt.role ?? "", 256),
      detail: preview(view.prompt.task, 8192),
      threadId: view.prompt.parentThreadId ?? "",
    };
  return {
    text: "Merged from",
    note: view.context.patchApplied ? "Code changes included" : "",
    detail: preview(view.context.summary, 8192),
    threadId: view.context.sourceThreadId,
  };
}
