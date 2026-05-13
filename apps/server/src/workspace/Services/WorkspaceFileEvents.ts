import { Schema, ServiceMap, Stream } from "effect";

import type { ProjectFileEvent } from "@ace/contracts";

import type {
  WorkspacePathOutsideRootError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
} from "./WorkspacePaths.ts";

export class WorkspaceFileEventsError extends Schema.TaggedErrorClass<WorkspaceFileEventsError>()(
  "WorkspaceFileEventsError",
  {
    cwd: Schema.String,
    detail: Schema.String,
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface WorkspaceFileEventsShape {
  readonly watch: (
    cwd: string,
  ) => Stream.Stream<
    ProjectFileEvent,
    | WorkspaceFileEventsError
    | WorkspacePathOutsideRootError
    | WorkspaceRootCreateFailedError
    | WorkspaceRootNotDirectoryError
    | WorkspaceRootNotExistsError
  >;
}

export class WorkspaceFileEvents extends ServiceMap.Service<
  WorkspaceFileEvents,
  WorkspaceFileEventsShape
>()("ace/workspace/Services/WorkspaceFileEvents") {}
