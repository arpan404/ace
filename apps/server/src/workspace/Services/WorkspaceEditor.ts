import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  WorkspaceEditorCloseBufferInput,
  WorkspaceEditorCloseBufferResult,
  WorkspaceEditorSyncBufferInput,
  WorkspaceEditorSyncBufferResult,
} from "@t3tools/contracts";

import type { WorkspacePathsError } from "./WorkspacePaths.ts";

export class WorkspaceEditorError extends Schema.TaggedErrorClass<WorkspaceEditorError>()(
  "WorkspaceEditorError",
  {
    cause: Schema.optional(Schema.Defect),
    cwd: Schema.String,
    detail: Schema.String,
    operation: Schema.String,
    relativePath: Schema.optional(Schema.String),
  },
) {}

export interface WorkspaceEditorShape {
  readonly syncBuffer: (
    input: WorkspaceEditorSyncBufferInput,
  ) => Effect.Effect<WorkspaceEditorSyncBufferResult, WorkspaceEditorError | WorkspacePathsError>;
  readonly closeBuffer: (
    input: WorkspaceEditorCloseBufferInput,
  ) => Effect.Effect<WorkspaceEditorCloseBufferResult, WorkspaceEditorError | WorkspacePathsError>;
}

export class WorkspaceEditor extends ServiceMap.Service<WorkspaceEditor, WorkspaceEditorShape>()(
  "t3/workspace/Services/WorkspaceEditor",
) {}
