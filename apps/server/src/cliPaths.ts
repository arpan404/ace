import { Effect, FileSystem, Path } from "effect";

import { expandHomePath } from "./os-jank";
import {
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
} from "./workspace/Services/WorkspacePaths";

export const resolveCliPath = Effect.fn("resolveCliPath")(function* (rawPath: string) {
  const path = yield* Path.Path;
  return path.resolve(yield* expandHomePath(rawPath.trim()));
});

export const normalizeCliWorkspaceRoot = Effect.fn("normalizeCliWorkspaceRoot")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const normalizedWorkspaceRoot = yield* resolveCliPath(workspaceRoot);
  const workspaceStat = yield* fileSystem
    .stat(normalizedWorkspaceRoot)
    .pipe(Effect.catch(() => Effect.succeed(null)));

  if (!workspaceStat) {
    return yield* new WorkspaceRootNotExistsError({
      workspaceRoot,
      normalizedWorkspaceRoot,
    });
  }

  if (workspaceStat.type !== "Directory") {
    return yield* new WorkspaceRootNotDirectoryError({
      workspaceRoot,
      normalizedWorkspaceRoot,
    });
  }

  return normalizedWorkspaceRoot;
});

export const deriveProjectTitleFromWorkspaceRoot = Effect.fn("deriveProjectTitleFromWorkspaceRoot")(
  function* (workspaceRoot: string) {
    const path = yield* Path.Path;
    return path.basename(workspaceRoot) || workspaceRoot;
  },
);
