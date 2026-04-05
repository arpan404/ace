import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ProjectReadFileInput, ProjectWriteFileInput } from "./project";

export const WorkspaceEditorDiagnosticSeverity = Schema.Literals([
  "error",
  "warning",
  "info",
  "hint",
]);
export type WorkspaceEditorDiagnosticSeverity = typeof WorkspaceEditorDiagnosticSeverity.Type;

export const WorkspaceEditorDiagnostic = Schema.Struct({
  code: Schema.optional(Schema.String),
  endColumn: NonNegativeInt,
  endLine: NonNegativeInt,
  message: Schema.String,
  severity: WorkspaceEditorDiagnosticSeverity,
  source: Schema.optional(TrimmedNonEmptyString),
  startColumn: NonNegativeInt,
  startLine: NonNegativeInt,
});
export type WorkspaceEditorDiagnostic = typeof WorkspaceEditorDiagnostic.Type;

export const WorkspaceEditorSyncBufferInput = Schema.Struct({
  contents: ProjectWriteFileInput.fields.contents,
  cwd: ProjectReadFileInput.fields.cwd,
  relativePath: ProjectReadFileInput.fields.relativePath,
});
export type WorkspaceEditorSyncBufferInput = typeof WorkspaceEditorSyncBufferInput.Type;

export const WorkspaceEditorSyncBufferResult = Schema.Struct({
  diagnostics: Schema.Array(WorkspaceEditorDiagnostic),
  relativePath: ProjectReadFileInput.fields.relativePath,
});
export type WorkspaceEditorSyncBufferResult = typeof WorkspaceEditorSyncBufferResult.Type;

export class WorkspaceEditorSyncBufferError extends Schema.TaggedErrorClass<WorkspaceEditorSyncBufferError>()(
  "WorkspaceEditorSyncBufferError",
  {
    cause: Schema.optional(Schema.Defect),
    message: TrimmedNonEmptyString,
  },
) {}

export const WorkspaceEditorCloseBufferInput = Schema.Struct({
  cwd: ProjectReadFileInput.fields.cwd,
  relativePath: ProjectReadFileInput.fields.relativePath,
});
export type WorkspaceEditorCloseBufferInput = typeof WorkspaceEditorCloseBufferInput.Type;

export const WorkspaceEditorCloseBufferResult = Schema.Struct({
  relativePath: ProjectReadFileInput.fields.relativePath,
});
export type WorkspaceEditorCloseBufferResult = typeof WorkspaceEditorCloseBufferResult.Type;

export class WorkspaceEditorCloseBufferError extends Schema.TaggedErrorClass<WorkspaceEditorCloseBufferError>()(
  "WorkspaceEditorCloseBufferError",
  {
    cause: Schema.optional(Schema.Defect),
    message: TrimmedNonEmptyString,
  },
) {}
