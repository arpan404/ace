import type { ContextDiagnostic } from "@ace/protocol";
/** Provider and storage diagnostics become actionable prose before entering the transcript. */
export function contextNotice(diagnostic: ContextDiagnostic): string {
  if (diagnostic.code === "truncated")
    return diagnostic.path
      ? `Only part of ${diagnostic.path} fit in this message. Mention a smaller line range to include the part you need.`
      : "Some context was shortened to fit this message. Reference a smaller section if the agent needs more detail.";
  if (diagnostic.code === "not_found")
    return diagnostic.path
      ? `${diagnostic.path} couldn't be included because it is no longer available. Choose the file again.`
      : "Some context is no longer available. Add it again before sending another message.";
  if (diagnostic.code === "binary")
    return "A file could not be included as text. Attach it so the agent can read it from disk.";
  if (
    diagnostic.code === "ignored" ||
    diagnostic.code === "outside_workspace" ||
    diagnostic.code === "forbidden"
  )
    return "A file could not be included from this project. Choose an accessible file or attach a copy.";
  if (diagnostic.code === "quota")
    return "There wasn't room for all the attached context. Remove unused attachments or send a smaller selection.";
  return "Some context could not be included. Check the files and attachments, then try again.";
}
