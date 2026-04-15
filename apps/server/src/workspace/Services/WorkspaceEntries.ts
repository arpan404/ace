/**
 * WorkspaceEntries - Effect service contract for cached workspace entry search.
 *
 * Owns indexed workspace entry search plus cache invalidation for workspace
 * roots when the underlying filesystem changes.
 *
 * @module WorkspaceEntries
 */
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectListTreeResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@ace/contracts";

export class WorkspaceEntriesError extends Schema.TaggedErrorClass<WorkspaceEntriesError>()(
  "WorkspaceEntriesError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class WorkspaceEntriesBrowseError extends Schema.TaggedErrorClass<WorkspaceEntriesBrowseError>()(
  "WorkspaceEntriesBrowseError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * WorkspaceEntriesShape - Service API for workspace entry search and cache
 * invalidation.
 */
export interface WorkspaceEntriesShape {
  /**
   * Browse matching directories for the provided partial path.
   */
  readonly browse: (
    input: FilesystemBrowseInput,
  ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;

  /**
   * Search indexed workspace entries for files and directories matching the
   * provided query.
   */
  readonly search: (
    input: ProjectSearchEntriesInput,
  ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;

  /**
   * Return the cached workspace tree for the given workspace root.
   */
  readonly listTree: (cwd: string) => Effect.Effect<ProjectListTreeResult, WorkspaceEntriesError>;

  /**
   * Drop any cached workspace entries for the given workspace root.
   */
  readonly invalidate: (cwd: string) => Effect.Effect<void>;
}

/**
 * WorkspaceEntries - Service tag for cached workspace entry search.
 */
export class WorkspaceEntries extends ServiceMap.Service<WorkspaceEntries, WorkspaceEntriesShape>()(
  "ace/workspace/Services/WorkspaceEntries",
) {}
