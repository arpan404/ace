import type { WorkspaceEditorDiagnostic, WorkspaceEditorLocation } from "@ace/contracts";
import * as Schema from "effect/Schema";

export const WorkspaceDesignerToolSchema = Schema.Literals([
  "code-comment",
  "range-review",
  "diagnostic-fix",
  "symbol-explain",
]);
export type WorkspaceDesignerTool = typeof WorkspaceDesignerToolSchema.Type;

export const WorkspaceDesignerPillPositionSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type WorkspaceDesignerPillPosition = typeof WorkspaceDesignerPillPositionSchema.Type;

export const WorkspaceDesignerStateSchema = Schema.Struct({
  active: Schema.Boolean,
  pillPosition: Schema.NullOr(WorkspaceDesignerPillPositionSchema),
  tool: WorkspaceDesignerToolSchema,
});
export type WorkspaceDesignerState = typeof WorkspaceDesignerStateSchema.Type;

export type WorkspaceCodeCommentStatus = "open" | "queued" | "resolved";
export type WorkspaceCodeCommentSource = "user" | "agent";

export interface WorkspaceCodeComment {
  readonly body: string;
  readonly code: string;
  readonly createdAt: string;
  readonly cwd: string;
  readonly id: string;
  readonly range: WorkspaceEditorLocation;
  readonly relativePath: string;
  readonly source: WorkspaceCodeCommentSource;
  readonly status: WorkspaceCodeCommentStatus;
}

export interface WorkspaceSelectionContext {
  readonly cwd: string;
  readonly diagnostics: readonly WorkspaceEditorDiagnostic[];
  readonly kind: "workspace-selection";
  readonly languageId: string | null;
  readonly range: WorkspaceEditorLocation;
  readonly relativePath: string;
  readonly text: string;
}

export function createWorkspaceDesignerState(): WorkspaceDesignerState {
  return {
    active: false,
    pillPosition: null,
    tool: "code-comment",
  };
}

export function formatWorkspaceRangeLabel(location: WorkspaceEditorLocation): string {
  const startLine = location.startLine + 1;
  const endLine = location.endLine + 1;
  if (startLine === endLine) {
    return `${location.relativePath}:${startLine}`;
  }
  return `${location.relativePath}:${startLine}-${endLine}`;
}

export function buildWorkspaceSelectionContext(input: {
  readonly cwd: string;
  readonly diagnostics: readonly WorkspaceEditorDiagnostic[];
  readonly languageId: string | null;
  readonly range: WorkspaceEditorLocation;
  readonly text: string;
}): WorkspaceSelectionContext {
  return {
    cwd: input.cwd,
    diagnostics: input.diagnostics.filter((diagnostic) =>
      diagnosticIntersectsLocation(diagnostic, input.range),
    ),
    kind: "workspace-selection",
    languageId: input.languageId,
    range: input.range,
    relativePath: input.range.relativePath,
    text: input.text,
  };
}

export function buildWorkspaceSelectionPrompt(
  context: WorkspaceSelectionContext,
  intent: "ask" | "fix" | "review" | "explain",
): string {
  const label = formatWorkspaceRangeLabel(context.range);
  const diagnostics =
    context.diagnostics.length > 0
      ? [
          "",
          "Diagnostics:",
          ...context.diagnostics.map(
            (diagnostic) =>
              `- ${diagnostic.severity}: ${diagnostic.message} (${diagnostic.source ?? "lsp"})`,
          ),
        ]
      : [];
  const heading =
    intent === "fix"
      ? `Fix the selected code at ${label}.`
      : intent === "review"
        ? `Review the selected code at ${label}.`
        : intent === "explain"
          ? `Explain the symbol or selected code at ${label}.`
          : `Use this selected code as context: ${label}.`;

  return [
    heading,
    "",
    "```" + (context.languageId ?? ""),
    context.text,
    "```",
    ...diagnostics,
  ].join("\n");
}

export function createWorkspaceCodeComment(input: {
  readonly body: string;
  readonly code: string;
  readonly cwd: string;
  readonly id: string;
  readonly range: WorkspaceEditorLocation;
  readonly createdAt: string;
  readonly source?: WorkspaceCodeCommentSource;
  readonly status?: WorkspaceCodeCommentStatus;
}): WorkspaceCodeComment {
  return {
    body: input.body.trim(),
    code: input.code,
    createdAt: input.createdAt,
    cwd: input.cwd,
    id: input.id,
    range: input.range,
    relativePath: input.range.relativePath,
    source: input.source ?? "user",
    status: input.status ?? "open",
  };
}

export function formatWorkspaceCodeCommentTitle(comment: WorkspaceCodeComment): string {
  return formatWorkspaceRangeLabel(comment.range);
}

export function updateWorkspaceCodeCommentStatus(
  comments: readonly WorkspaceCodeComment[],
  commentId: string,
  status: WorkspaceCodeCommentStatus,
): readonly WorkspaceCodeComment[] {
  return comments.map((comment) => (comment.id === commentId ? { ...comment, status } : comment));
}

export function countOpenWorkspaceCodeComments(
  comments: readonly WorkspaceCodeComment[],
  relativePath?: string | null,
): number {
  return comments.filter(
    (comment) =>
      comment.status !== "resolved" &&
      (relativePath === undefined ||
        relativePath === null ||
        comment.relativePath === relativePath),
  ).length;
}

function diagnosticIntersectsLocation(
  diagnostic: WorkspaceEditorDiagnostic,
  location: WorkspaceEditorLocation,
): boolean {
  const diagnosticStart = toOffsetComparable(diagnostic.startLine, diagnostic.startColumn);
  const diagnosticEnd = toOffsetComparable(diagnostic.endLine, diagnostic.endColumn);
  const locationStart = toOffsetComparable(location.startLine, location.startColumn);
  const locationEnd = toOffsetComparable(location.endLine, location.endColumn);
  return diagnosticStart <= locationEnd && diagnosticEnd >= locationStart;
}

function toOffsetComparable(line: number, column: number): number {
  return line * 1_000_000 + column;
}
