import type { ReviewAnchor, ReviewComment } from "@ace/protocol";
import { quotePath } from "./patch.ts";

export function selectedUnterminated(anchor: ReviewAnchor): boolean {
  return Boolean(anchor.fingerprint.noFinalNewline && anchor.fingerprint.after.length === 0);
}

export function suggestionPatch(comment: ReviewComment): string {
  if (
    comment.anchor.state === "outdated" ||
    comment.resolved ||
    comment.anchor.position.side !== "new" ||
    comment.suggestion === undefined
  )
    throw new Error("review_suggestion_unavailable");
  const { position: p, fingerprint: f } = comment.anchor;
  const suggestion = comment.suggestion;
  const replacement =
    comment.suggestion === "" ? [] : comment.suggestion.replace(/\n$/, "").split("\n");
  const start = p.start - f.before.length;
  const oldCount = f.before.length + f.lines.length + f.after.length;
  const newCount = f.before.length + replacement.length + f.after.length;
  const marker = "\\ No newline at end of file";
  const selectedEndsAtEof = selectedUnterminated(comment.anchor);
  const old = f.lines.flatMap((line, offset) => [
    "-" + line,
    ...(selectedEndsAtEof && offset === f.lines.length - 1 ? [marker] : []),
  ]);
  const added: string[] = [];
  for (const [offset, line] of replacement.entries()) {
    added.push("+" + line);
    if (selectedEndsAtEof && !suggestion.endsWith("\n") && offset === replacement.length - 1)
      added.push(marker);
  }
  const after = f.after.flatMap((line, offset) => [
    " " + line,
    ...(f.noFinalNewline && offset === f.after.length - 1 ? [marker] : []),
  ]);
  const path = p.file;
  return [
    `diff --git ${quotePath("a/" + path)} ${quotePath("b/" + path)}`,
    `--- ${quotePath("a/" + path)}`,
    `+++ ${quotePath("b/" + path)}`,
    `@@ -${start},${oldCount} +${newCount === 0 ? start - 1 : start},${newCount} @@`,
    ...f.before.map((line) => " " + line),
    ...old,
    ...added,
    ...after,
    "",
  ].join("\n");
}
