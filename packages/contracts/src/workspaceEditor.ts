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

export const WorkspaceEditorCompletionItem = Schema.Struct({
  label: TrimmedNonEmptyString,
  kind: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(Schema.String),
  documentation: Schema.optional(Schema.String),
  insertText: Schema.optional(Schema.String),
  sortText: Schema.optional(TrimmedNonEmptyString),
  filterText: Schema.optional(TrimmedNonEmptyString),
});
export type WorkspaceEditorCompletionItem = typeof WorkspaceEditorCompletionItem.Type;

export const WorkspaceEditorLocation = Schema.Struct({
  relativePath: ProjectReadFileInput.fields.relativePath,
  startLine: NonNegativeInt,
  startColumn: NonNegativeInt,
  endLine: NonNegativeInt,
  endColumn: NonNegativeInt,
});
export type WorkspaceEditorLocation = typeof WorkspaceEditorLocation.Type;

const WorkspaceEditorPositionFields = {
  line: NonNegativeInt,
  column: NonNegativeInt,
} as const;

const WorkspaceEditorLspRequestFields = {
  contents: ProjectWriteFileInput.fields.contents,
  cwd: ProjectReadFileInput.fields.cwd,
  relativePath: ProjectReadFileInput.fields.relativePath,
  ...WorkspaceEditorPositionFields,
} as const;

export const WorkspaceEditorCompleteInput = Schema.Struct(WorkspaceEditorLspRequestFields);
export type WorkspaceEditorCompleteInput = typeof WorkspaceEditorCompleteInput.Type;

export const WorkspaceEditorCompleteResult = Schema.Struct({
  relativePath: ProjectReadFileInput.fields.relativePath,
  items: Schema.Array(WorkspaceEditorCompletionItem),
});
export type WorkspaceEditorCompleteResult = typeof WorkspaceEditorCompleteResult.Type;

export class WorkspaceEditorCompleteError extends Schema.TaggedErrorClass<WorkspaceEditorCompleteError>()(
  "WorkspaceEditorCompleteError",
  {
    cause: Schema.optional(Schema.Defect),
    message: TrimmedNonEmptyString,
  },
) {}

export const WorkspaceEditorDefinitionInput = Schema.Struct(WorkspaceEditorLspRequestFields);
export type WorkspaceEditorDefinitionInput = typeof WorkspaceEditorDefinitionInput.Type;

export const WorkspaceEditorDefinitionResult = Schema.Struct({
  relativePath: ProjectReadFileInput.fields.relativePath,
  locations: Schema.Array(WorkspaceEditorLocation),
});
export type WorkspaceEditorDefinitionResult = typeof WorkspaceEditorDefinitionResult.Type;

export class WorkspaceEditorDefinitionError extends Schema.TaggedErrorClass<WorkspaceEditorDefinitionError>()(
  "WorkspaceEditorDefinitionError",
  {
    cause: Schema.optional(Schema.Defect),
    message: TrimmedNonEmptyString,
  },
) {}

export const WorkspaceEditorReferencesInput = Schema.Struct(WorkspaceEditorLspRequestFields);
export type WorkspaceEditorReferencesInput = typeof WorkspaceEditorReferencesInput.Type;

export const WorkspaceEditorReferencesResult = Schema.Struct({
  relativePath: ProjectReadFileInput.fields.relativePath,
  locations: Schema.Array(WorkspaceEditorLocation),
});
export type WorkspaceEditorReferencesResult = typeof WorkspaceEditorReferencesResult.Type;

export class WorkspaceEditorReferencesError extends Schema.TaggedErrorClass<WorkspaceEditorReferencesError>()(
  "WorkspaceEditorReferencesError",
  {
    cause: Schema.optional(Schema.Defect),
    message: TrimmedNonEmptyString,
  },
) {}
