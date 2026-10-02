import type { ReviewComment } from "@ace/protocol";
import { quotePath } from "./patch.ts";

export function suggestionPatch(comment: ReviewComment): string {
  if (
    comment.anchor.state === "outdated" ||
    comment.resolved ||
    comment.anchor.position.side !== "new" ||
    comment.suggestion === undefined
  )
    throw new Error("review_suggestion_unavailable");
  const { position: p, fingerprint: f } = comment.anchor;
  const replacement =
    comment.suggestion === "" ? [] : comment.suggestion.replace(/\n$/, "").split("\n");
  const start = p.start - f.before.length;
  const oldCount = f.before.length + f.lines.length + f.after.length;
  const newCount = f.before.length + replacement.length + f.after.length;
  const path = p.file;
  return [
    `diff --git ${quotePath("a/" + path)} ${quotePath("b/" + path)}`,
    `--- ${quotePath("a/" + path)}`,
    `+++ ${quotePath("b/" + path)}`,
    `@@ -${start},${oldCount} +${start},${newCount} @@`,
    ...f.before.map((line) => " " + line),
    ...f.lines.map((line) => "-" + line),
    ...replacement.map((line) => "+" + line),
    ...f.after.map((line) => " " + line),
    "",
  ].join("\n");
}
