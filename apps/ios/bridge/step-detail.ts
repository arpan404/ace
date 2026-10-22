import type { Item } from "@ace/protocol";
import { patchLines, stepPath, stripAnsi, type PathContext } from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * What an opened step shows on the phone, as the web's step detail does (`step-detail.tsx`): a
 * command's output tail, each changed file as a compact diff, a search's matches, the page a
 * fetch read, a failure's words. Bounded: a step row never carries a whole file or log. Pure
 * over the item.
 */

const diffFiles = 4;
const diffLines = 160;

function diffOf(
  change: {
    path: string;
    movePath?: string | undefined;
    kind: string;
    diff?: string | undefined;
    newText?: string | undefined;
  },
  context: PathContext,
) {
  const path = (value: string) => stepPath(value, context).text;
  const all = change.diff
    ? patchLines(change.diff)
    : (change.newText ?? "").split("\n").map((text) => ({ kind: "add" as const, text }));
  return {
    path: preview(
      change.movePath ? `${path(change.path)} → ${path(change.movePath)}` : path(change.path),
      512,
    ),
    kind: change.kind === "update" ? "" : change.kind,
    lines: all
      .slice(0, diffLines)
      .map((line) => ({ kind: line.kind, text: preview(line.text, 512) })),
    more: Math.max(0, all.length - diffLines),
  };
}

export function stepDetail(item: Item, context: PathContext = {}) {
  const none = {
    output: "",
    outputTruncated: false,
    text: "",
    diffs: [] as ReturnType<typeof diffOf>[],
  };
  if (item.type === "notice") return { ...none, text: preview(item.text, 2048) };
  if (item.type !== "tool_call") return null;
  const { detail, error } = item.call;
  const lines: string[] = [];
  if (error) lines.push(error);
  if (detail.kind === "search" && detail.matches !== undefined)
    lines.push(`${detail.matches} ${detail.matches === 1 ? "match" : "matches"}`);
  if (detail.kind === "web.search") lines.push(`Searched for “${detail.query}”`);
  if (detail.kind === "web.fetch") lines.push(detail.url);
  if (detail.kind === "agent.message" && detail.message) lines.push(detail.message);
  const output = detail.kind === "shell" ? detail.output : undefined;
  return {
    output: output ? stripAnsi(output.tail) : "",
    outputTruncated: output?.truncated === true,
    text: preview(lines.join("\n"), 2048),
    diffs:
      "changes" in detail
        ? detail.changes.slice(0, diffFiles).map((change) => diffOf(change, context))
        : [],
  };
}
