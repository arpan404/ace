export type WorkspaceCommentPlaceholderContext = "general" | "code" | "diff" | "design";

const WORKSPACE_COMMENT_PLACEHOLDERS = [
  "Leave a note",
  "Ask for review",
  "Request a tweak",
  "Flag a concern",
  "Suggest a fix",
  "Add reviewer context",
  "Ask a follow-up",
  "Make this safer",
  "Clarify the intent",
  "Improve wording",
  "Reduce the scope",
  "Keep this simple",
] as const;

const CODE_COMMENT_PLACEHOLDERS = [
  "Question this logic",
  "Explain this branch",
  "Tighten this logic",
  "Simplify this path",
  "Rename for clarity",
  "Extract a helper",
  "Use existing helper",
  "Add a guard",
  "Handle empty input",
  "Handle null value",
  "Improve error handling",
  "Add test coverage",
  "Cover this case",
  "Verify this output",
  "Preserve current behavior",
  "Confirm intended behavior",
  "Check the contract",
  "Validate the input",
  "Review state updates",
  "Check async flow",
  "Handle loading state",
  "Handle failure state",
  "Review retry behavior",
  "Remove duplicate logic",
  "Follow existing pattern",
  "Trace the caller",
  "Find related usage",
  "Check this import",
  "Check this export",
  "Tighten the type",
  "Review the schema",
  "Review the query",
  "Review cache behavior",
  "Avoid stale data",
  "Check race condition",
  "Review side effects",
  "Check boundary case",
  "Cover edge case",
  "Set better default",
  "Improve fallback path",
] as const;

const DIFF_COMMENT_PLACEHOLDERS = [
  "Review this hunk",
  "Question this change",
  "Explain this diff",
  "Flag regression risk",
  "Preserve old behavior",
  "Check changed path",
  "Check removed logic",
  "Check added logic",
  "Compare before after",
  "Verify this deletion",
  "Verify this addition",
  "Request smaller change",
  "Split this change",
  "Review test impact",
  "Add missing test",
  "Check migration risk",
  "Check rollback path",
  "Confirm file scope",
  "Review adjacent changes",
  "Check hidden coupling",
  "Review API impact",
  "Check data shape",
  "Check error path",
  "Check edge behavior",
  "Check performance impact",
  "Check security impact",
  "Check compatibility risk",
  "Guard against regression",
  "Add useful logs",
  "Review telemetry event",
  "Handle cancellation",
  "Handle reconnect flow",
  "Review dependency use",
  "Check version support",
  "Check working directory",
  "Use relative path",
  "Check file path",
  "Review parsing logic",
  "Review mutation flow",
  "Verify the result",
] as const;

const DESIGN_COMMENT_PLACEHOLDERS = [
  "Tighten this UI",
  "Improve this copy",
  "Adjust the spacing",
  "Improve this label",
  "Clarify affordance",
  "Clarify the action",
  "Reduce visual noise",
  "Match nearby style",
  "Fix focus behavior",
  "Check keyboard flow",
  "Check mobile layout",
  "Check narrow width",
  "Fix scroll behavior",
  "Fix layout shift",
  "Review highlighting",
  "Fix overflow issue",
  "Improve empty state",
  "Check contrast",
  "Check alignment",
  "Check hierarchy",
  "Reduce chrome",
  "Simplify this control",
  "Make this quieter",
  "Make this clearer",
  "Improve tap target",
  "Check hover state",
  "Check active state",
  "Check disabled state",
  "Review motion",
  "Review density",
  "Improve grouping",
  "Use better icon",
  "Remove extra label",
  "Clean this panel",
  "Polish this edge",
  "Balance this section",
  "Check text wrapping",
  "Check responsive layout",
  "Improve visual rhythm",
  "Make it cleaner",
] as const;

export const WORKSPACE_COMMENT_PLACEHOLDERS_BY_CONTEXT = {
  code: CODE_COMMENT_PLACEHOLDERS,
  design: DESIGN_COMMENT_PLACEHOLDERS,
  diff: DIFF_COMMENT_PLACEHOLDERS,
  general: WORKSPACE_COMMENT_PLACEHOLDERS,
} as const satisfies Record<WorkspaceCommentPlaceholderContext, readonly string[]>;

export function getWorkspaceCommentPlaceholder(
  options: {
    context?: WorkspaceCommentPlaceholderContext;
    timestampMs?: number;
  } = {},
): string {
  const context = options.context ?? "general";
  const placeholders = WORKSPACE_COMMENT_PLACEHOLDERS_BY_CONTEXT[context];
  const timestampMs = options.timestampMs ?? Date.now();
  const index = Math.abs(Math.trunc(timestampMs)) % placeholders.length;
  return placeholders[index]!;
}

function hashWorkspaceCommentPlaceholderSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function useWorkspaceCommentPlaceholder(
  context: WorkspaceCommentPlaceholderContext = "general",
  sessionKey: string | number | null | undefined = null,
): string {
  const seed =
    sessionKey === null || sessionKey === undefined ? context : `${context}:${sessionKey}`;
  return getWorkspaceCommentPlaceholder({
    context,
    timestampMs: hashWorkspaceCommentPlaceholderSeed(seed),
  });
}
