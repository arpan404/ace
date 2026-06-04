import { Effect, FileSystem, Layer, Path } from "effect";
import { createHash } from "node:crypto";
import { stat as statFile } from "node:fs/promises";
import { PROJECT_READ_FILE_MAX_BYTES } from "@ace/contracts";
import type { ProjectReadFileResult } from "@ace/contracts";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const READ_FILE_CACHE_MAX_ENTRIES = 128;
const READ_FILE_CACHE_TTL_MS = 60_000;

interface ReadFileCacheEntry {
  readonly absolutePath: string;
  readonly fingerprint: string;
  readonly result: ProjectReadFileResult;
  readonly storedAt: number;
}

function computeFileVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createStatFingerprint(stats: {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}): string {
  return [
    stats.dev.toString(),
    stats.ino.toString(),
    stats.size.toString(),
    stats.mtimeNs.toString(),
    stats.ctimeNs.toString(),
  ].join(":");
}

function isPathAtOrWithinPrefix(absolutePath: string, prefix: string): boolean {
  return (
    absolutePath === prefix ||
    absolutePath.startsWith(`${prefix}/`) ||
    absolutePath.startsWith(`${prefix}\\`)
  );
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;
  const readFileCache = new Map<string, ReadFileCacheEntry>();

  const statOrNull = (absolutePath: string) =>
    fileSystem.stat(absolutePath).pipe(Effect.catch(() => Effect.succeed(null)));

  const invalidateWorkspaceEntries = (cwd: string) => workspaceEntries.invalidate(cwd);

  const invalidateReadFileCachePath = (absolutePath: string) => {
    readFileCache.delete(absolutePath);
  };

  const invalidateReadFileCachePrefix = (absolutePath: string) => {
    for (const cacheKey of readFileCache.keys()) {
      if (isPathAtOrWithinPrefix(cacheKey, absolutePath)) {
        readFileCache.delete(cacheKey);
      }
    }
  };

  const pruneReadFileCache = () => {
    while (readFileCache.size > READ_FILE_CACHE_MAX_ENTRIES) {
      const oldestKey = readFileCache.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      readFileCache.delete(oldestKey);
    }
  };

  const readFileCacheCandidate = (input: {
    absolutePath: string;
    cwd: string;
    relativePath: string;
  }): Effect.Effect<
    { readonly cached: ProjectReadFileResult | null; readonly fingerprint: string },
    WorkspaceFileSystemError
  > =>
    Effect.gen(function* () {
      const stats = yield* Effect.tryPromise({
        try: () => statFile(input.absolutePath, { bigint: true }),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.stat",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      if (!stats.isFile()) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Only regular text files can be opened in the editor.",
        });
      }
      if (stats.size > BigInt(PROJECT_READ_FILE_MAX_BYTES)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: `Files larger than ${Math.round(PROJECT_READ_FILE_MAX_BYTES / (1024 * 1024))}MB are not opened in the in-app editor.`,
        });
      }

      const fingerprint = createStatFingerprint(stats);
      const cached = readFileCache.get(input.absolutePath);
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        Date.now() - cached.storedAt <= READ_FILE_CACHE_TTL_MS
      ) {
        readFileCache.delete(input.absolutePath);
        readFileCache.set(input.absolutePath, cached);
        return { cached: cached.result, fingerprint };
      }
      return { cached: null, fingerprint };
    });

  const failAlreadyExists = (input: { cwd: string; relativePath: string }, operation: string) =>
    new WorkspaceFileSystemError({
      cwd: input.cwd,
      relativePath: input.relativePath,
      operation,
      detail: "An entry already exists at that path.",
    });

  const failMissingEntry = (input: { cwd: string; relativePath: string }, operation: string) =>
    new WorkspaceFileSystemError({
      cwd: input.cwd,
      relativePath: input.relativePath,
      operation,
      detail: "That workspace entry no longer exists.",
    });

  const createEntry: WorkspaceFileSystemShape["createEntry"] = Effect.fn(
    "WorkspaceFileSystem.createEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const existing = yield* statOrNull(target.absolutePath);
    if (existing) {
      return yield* failAlreadyExists(input, "workspaceFileSystem.createEntry");
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );

    if (input.kind === "directory") {
      yield* fileSystem.makeDirectory(target.absolutePath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.createDirectory",
              detail: cause.message,
              cause,
            }),
        ),
      );
    } else {
      yield* fileSystem.writeFileString(target.absolutePath, "").pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.createFile",
              detail: cause.message,
              cause,
            }),
        ),
      );
    }

    invalidateReadFileCachePath(target.absolutePath);
    yield* invalidateWorkspaceEntries(input.cwd);
    return {
      kind: input.kind,
      relativePath: target.relativePath,
    };
  });

  const deleteEntry: WorkspaceFileSystemShape["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const existing = yield* statOrNull(target.absolutePath);
    if (!existing) {
      return yield* failMissingEntry(input, "workspaceFileSystem.deleteEntry");
    }

    yield* fileSystem.remove(target.absolutePath, { force: true, recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.deleteEntry",
            detail: cause.message,
            cause,
          }),
      ),
    );

    invalidateReadFileCachePrefix(target.absolutePath);
    yield* invalidateWorkspaceEntries(input.cwd);
    return { relativePath: target.relativePath };
  });

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const existingStat = yield* statOrNull(target.absolutePath);
    if (existingStat && existingStat.type !== "File") {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.writeFile",
        detail: "Only regular files can be written in the workspace editor.",
      });
    }

    const existingBytes =
      existingStat && existingStat.type === "File"
        ? yield* fileSystem.readFile(target.absolutePath).pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceFileSystemError({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  operation: "workspaceFileSystem.readFile",
                  detail: cause.message,
                  cause,
                }),
            ),
          )
        : null;
    const currentVersion = existingBytes ? computeFileVersion(existingBytes) : undefined;
    const currentContents = existingBytes
      ? (() => {
          try {
            return utf8Decoder.decode(existingBytes);
          } catch {
            return undefined;
          }
        })()
      : undefined;

    if (input.expectedVersion !== undefined && input.overwrite !== true) {
      if (input.expectedVersion !== currentVersion) {
        return yield* new WorkspaceFileSystemError({
          conflict: true,
          currentContents,
          currentVersion,
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.writeFileConflict",
          detail: "The file changed on disk after you opened it.",
          expectedVersion: input.expectedVersion,
        });
      }
    }

    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    invalidateReadFileCachePath(target.absolutePath);
    yield* workspaceEntries.invalidate(input.cwd);
    return {
      relativePath: target.relativePath,
      version: computeFileVersion(Buffer.from(input.contents, "utf8")),
    };
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const cacheCandidate = yield* readFileCacheCandidate({
        absolutePath: target.absolutePath,
        cwd: input.cwd,
        relativePath: target.relativePath,
      });
      if (cacheCandidate.cached) {
        return cacheCandidate.cached;
      }

      const bytes = yield* fileSystem.readFile(target.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.readFile",
              detail: cause.message,
              cause,
            }),
        ),
      );

      if (bytes.some((value) => value === 0)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Binary files are not supported in the in-app editor.",
        });
      }

      const contents = yield* Effect.try({
        try: () => utf8Decoder.decode(bytes),
        catch: () =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: "Only UTF-8 text files are supported in the in-app editor.",
          }),
      });

      const result = {
        contents,
        relativePath: target.relativePath,
        sizeBytes: bytes.byteLength,
        version: computeFileVersion(bytes),
      } satisfies ProjectReadFileResult;
      readFileCache.set(target.absolutePath, {
        absolutePath: target.absolutePath,
        fingerprint: cacheCandidate.fingerprint,
        result,
        storedAt: Date.now(),
      });
      pruneReadFileCache();
      return result;
    },
  );

  const renameEntry: WorkspaceFileSystemShape["renameEntry"] = Effect.fn(
    "WorkspaceFileSystem.renameEntry",
  )(function* (input) {
    const source = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.nextRelativePath,
    });

    if (source.relativePath === target.relativePath) {
      return {
        previousRelativePath: source.relativePath,
        relativePath: target.relativePath,
      };
    }

    const sourceStat = yield* statOrNull(source.absolutePath);
    if (!sourceStat) {
      return yield* failMissingEntry(input, "workspaceFileSystem.renameEntry");
    }

    const targetStat = yield* statOrNull(target.absolutePath);
    if (targetStat) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.nextRelativePath,
        operation: "workspaceFileSystem.renameEntry",
        detail: "An entry already exists at the destination path.",
      });
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.nextRelativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );

    yield* fileSystem.rename(source.absolutePath, target.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.renameEntry",
            detail: cause.message,
            cause,
          }),
      ),
    );

    invalidateReadFileCachePrefix(source.absolutePath);
    invalidateReadFileCachePrefix(target.absolutePath);
    yield* invalidateWorkspaceEntries(input.cwd);
    return {
      previousRelativePath: source.relativePath,
      relativePath: target.relativePath,
    };
  });

  return {
    createEntry,
    deleteEntry,
    readFile,
    renameEntry,
    writeFile,
  } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
