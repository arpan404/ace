import { relative } from "node:path";

import { Effect, Layer, PlatformError, Queue, Result, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ProjectFileEvent } from "@ace/contracts";

import {
  WorkspaceFileEvents,
  WorkspaceFileEventsError,
  type WorkspaceFileEventsShape,
} from "../Services/WorkspaceFileEvents.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WATCH_DEBOUNCE_MS = 120;
const MAX_PATHS_PER_EVENT = 512;
const MAX_WORKER_STDERR_BYTES = 8_192;
const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);
const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);

const WORKER_SOURCE = `
import { readdirSync, statSync, watch } from "node:fs";
import { join, relative } from "node:path";

const workspaceRoot = process.env.ACE_WORKSPACE_WATCH_ROOT;
if (!workspaceRoot) {
  process.stderr.write("missing ACE_WORKSPACE_WATCH_ROOT\\n");
  process.exit(1);
}

const WATCH_DEBOUNCE_MS = ${WATCH_DEBOUNCE_MS};
const MAX_PATHS_PER_EVENT = ${MAX_PATHS_PER_EVENT};
const IGNORED_PATH_SEGMENTS = new Set(${JSON.stringify(Array.from(IGNORED_PATH_SEGMENTS))});
const IGNORED_FILE_NAMES = new Set(${JSON.stringify(Array.from(IGNORED_FILE_NAMES))});
const watchers = [];
const watchedDirectories = new Set();
const pendingPaths = new Set();
let flushTimer = null;
let overflowed = false;
let closed = false;

function toPosixPath(input) {
  return input.replaceAll("\\\\", "/");
}

function normalizeEventPath(eventPath) {
  const normalized = toPosixPath(eventPath);
  const relativePath = normalized.startsWith("/")
    ? toPosixPath(relative(workspaceRoot, normalized))
    : normalized;
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    return null;
  }
  return relativePath;
}

function shouldIgnoreRelativePath(relativePath) {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return true;
  }
  if (segments.some((segment) => IGNORED_PATH_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = segments.at(-1);
  return basename === undefined || IGNORED_FILE_NAMES.has(basename) || basename.startsWith("._");
}

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingPaths.size === 0 && !overflowed) {
    return;
  }
  const relativePaths = Array.from(pendingPaths).sort((left, right) =>
    left.localeCompare(right),
  );
  pendingPaths.clear();
  const eventOverflowed = overflowed;
  overflowed = false;
  process.stdout.write(JSON.stringify({ overflowed: eventOverflowed, relativePaths }) + "\\n");
}

function scheduleFlush() {
  if (closed) {
    return;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

function trackPath(relativePath) {
  if (!relativePath || shouldIgnoreRelativePath(relativePath)) {
    return;
  }
  if (pendingPaths.size < MAX_PATHS_PER_EVENT) {
    pendingPaths.add(relativePath);
  } else if (!pendingPaths.has(relativePath)) {
    overflowed = true;
  }
  scheduleFlush();
}

function isExistingDirectory(absolutePath) {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function watchDirectory(relativeDirectoryPath) {
  if (closed || watchedDirectories.has(relativeDirectoryPath)) {
    return;
  }
  if (relativeDirectoryPath && shouldIgnoreRelativePath(relativeDirectoryPath)) {
    return;
  }
  const absoluteDirectoryPath = relativeDirectoryPath
    ? join(workspaceRoot, relativeDirectoryPath)
    : workspaceRoot;
  try {
    const watcher = watch(absoluteDirectoryPath, { persistent: true }, (eventType, filename) => {
      if (typeof filename !== "string" || filename.length === 0) {
        overflowed = true;
        scheduleFlush();
        return;
      }
      const candidatePath = relativeDirectoryPath
        ? relativeDirectoryPath + "/" + toPosixPath(filename)
        : toPosixPath(filename);
      const relativePath = normalizeEventPath(candidatePath);
      trackPath(relativePath);
      if (
        eventType === "rename" &&
        relativePath &&
        !shouldIgnoreRelativePath(relativePath) &&
        isExistingDirectory(join(workspaceRoot, relativePath))
      ) {
        watchDirectory(relativePath);
      }
    });
    watcher.on("error", (cause) => {
      process.stderr.write(String(cause?.stack || cause?.message || cause) + "\\n");
    });
    watchers.push(watcher);
    watchedDirectories.add(relativeDirectoryPath);
  } catch {
    // Ignore directories that disappear or cannot be watched.
  }
}

function scanDirectories() {
  const stack = [""];
  for (let index = 0; index < stack.length; index += 1) {
    const relativeDirectoryPath = stack[index];
    watchDirectory(relativeDirectoryPath);
    const absoluteDirectoryPath = relativeDirectoryPath
      ? join(workspaceRoot, relativeDirectoryPath)
      : workspaceRoot;
    let entries;
    try {
      entries = readdirSync(absoluteDirectoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const childPath = relativeDirectoryPath
        ? relativeDirectoryPath + "/" + entry.name
        : entry.name;
      if (!shouldIgnoreRelativePath(childPath)) {
        stack.push(childPath);
      }
    }
  }
}

function startRecursiveWatcher() {
  try {
    const watcher = watch(workspaceRoot, { persistent: true, recursive: true }, (_eventType, filename) => {
      if (typeof filename !== "string" || filename.length === 0) {
        overflowed = true;
        scheduleFlush();
        return;
      }
      trackPath(normalizeEventPath(filename));
    });
    watcher.on("error", (cause) => {
      process.stderr.write(String(cause?.stack || cause?.message || cause) + "\\n");
    });
    watchers.push(watcher);
    return true;
  } catch {
    return false;
  }
}

function shutdown(code) {
  closed = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {}
  }
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", (cause) => {
  process.stderr.write(String(cause?.stack || cause?.message || cause) + "\\n");
  shutdown(1);
});

if (!startRecursiveWatcher()) {
  scanDirectories();
}
`;

interface WorkerMessage {
  readonly overflowed: boolean;
  readonly relativePaths: ReadonlyArray<string>;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function normalizeEventPath(workspaceRoot: string, eventPath: string): string | null {
  const normalized = toPosixPath(eventPath);
  const relativePath = normalized.startsWith("/")
    ? toPosixPath(relative(workspaceRoot, normalized))
    : normalized;
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    return null;
  }
  return relativePath;
}

function shouldIgnoreRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return true;
  }
  if (segments.some((segment) => IGNORED_PATH_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = segments.at(-1);
  return basename === undefined || IGNORED_FILE_NAMES.has(basename) || basename.startsWith("._");
}

export const makeWorkspaceFileEvents = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const watchWorkspace: WorkspaceFileEventsShape["watch"] = (cwd) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(cwd);

        return Stream.callback<ProjectFileEvent, WorkspaceFileEventsError>(
          (queue) =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              let released = false;
              let stdoutRemainder = "";
              let stderrBuffer = "";

              const child = yield* childProcessSpawner
                .spawn(
                  ChildProcess.make(
                    process.execPath,
                    ["--input-type=module", "--eval", WORKER_SOURCE],
                    {
                      detached: false,
                      env: {
                        ACE_WORKSPACE_WATCH_ROOT: normalizedWorkspaceRoot,
                      },
                      extendEnv: true,
                      stderr: "pipe",
                      stdin: "ignore",
                      stdout: "pipe",
                    },
                  ),
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new WorkspaceFileEventsError({
                        cwd: normalizedWorkspaceRoot,
                        detail: "Failed to spawn workspace file watcher worker.",
                        operation: "workspaceFileEvents.spawnWorker",
                        cause,
                      }),
                  ),
                );

              const childStdout = child.stdout as Stream.Stream<
                Uint8Array,
                PlatformError.PlatformError,
                never
              >;
              const childStderr = child.stderr as Stream.Stream<
                Uint8Array,
                PlatformError.PlatformError,
                never
              >;
              const childExitCode = child.exitCode as Effect.Effect<
                unknown,
                PlatformError.PlatformError,
                never
              >;

              yield* Scope.addFinalizer(
                scope,
                Effect.gen(function* () {
                  released = true;
                  yield* child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
                }),
              );

              const failQueue = (detail: string, operation: string, cause?: unknown) =>
                Queue.fail(
                  queue,
                  new WorkspaceFileEventsError({
                    cwd: normalizedWorkspaceRoot,
                    detail,
                    operation,
                    cause,
                  }),
                ).pipe(Effect.asVoid);

              const emitMessage = (message: WorkerMessage) =>
                workspaceEntries.invalidate(normalizedWorkspaceRoot).pipe(
                  Effect.flatMap(() =>
                    Queue.offer(queue, {
                      cwd: normalizedWorkspaceRoot,
                      detectedAt: new Date().toISOString(),
                      overflowed: message.overflowed,
                      relativePaths: message.relativePaths,
                    }),
                  ),
                  Effect.asVoid,
                );

              const parseWorkerLine = (line: string): WorkerMessage | null => {
                const trimmedLine = line.trim();
                if (!trimmedLine) {
                  return null;
                }
                const parsed = JSON.parse(trimmedLine) as unknown;
                if (!parsed || typeof parsed !== "object") {
                  return null;
                }
                const record = parsed as Record<string, unknown>;
                if (
                  typeof record.overflowed !== "boolean" ||
                  !Array.isArray(record.relativePaths)
                ) {
                  return null;
                }
                const relativePaths = record.relativePaths
                  .filter((pathValue): pathValue is string => typeof pathValue === "string")
                  .map((pathValue) => normalizeEventPath(normalizedWorkspaceRoot, pathValue))
                  .filter((pathValue): pathValue is string => Boolean(pathValue))
                  .filter((pathValue) => !shouldIgnoreRelativePath(pathValue))
                  .slice(0, MAX_PATHS_PER_EVENT);
                if (relativePaths.length === 0 && !record.overflowed) {
                  return null;
                }
                return {
                  overflowed: record.overflowed,
                  relativePaths,
                };
              };

              const processStdoutChunk = (chunk: string) =>
                Effect.gen(function* () {
                  const combined = stdoutRemainder + chunk;
                  const lines = combined.split("\n");
                  stdoutRemainder = lines.pop() ?? "";
                  for (const line of lines) {
                    const parseResult = yield* Effect.result(
                      Effect.try({
                        try: () => parseWorkerLine(line),
                        catch: (cause) =>
                          new WorkspaceFileEventsError({
                            cwd: normalizedWorkspaceRoot,
                            detail: "Workspace file watcher worker emitted invalid JSON.",
                            operation: "workspaceFileEvents.parseWorkerMessage",
                            cause,
                          }),
                      }),
                    );
                    if (Result.isFailure(parseResult)) {
                      yield* failQueue(
                        parseResult.failure.detail,
                        parseResult.failure.operation,
                        parseResult.failure.cause,
                      );
                      continue;
                    }
                    const message = parseResult.success;
                    if (message) {
                      yield* emitMessage(message);
                    }
                  }
                });

              yield* childStdout.pipe(
                Stream.decodeText(),
                Stream.runForEach(processStdoutChunk),
                Effect.catch((cause: PlatformError.PlatformError) =>
                  failQueue(
                    "Workspace file watcher worker stdout stream failed.",
                    "workspaceFileEvents.readWorkerStdout",
                    cause,
                  ),
                ),
                Effect.forkScoped,
              );

              yield* childStderr.pipe(
                Stream.decodeText(),
                Stream.runForEach((chunk) =>
                  Effect.sync(() => {
                    stderrBuffer = (stderrBuffer + chunk).slice(-MAX_WORKER_STDERR_BYTES);
                  }),
                ),
                Effect.ignore,
                Effect.forkScoped,
              );

              yield* childExitCode.pipe(
                Effect.flatMap((exitCode) => {
                  if (released) {
                    return Effect.void;
                  }
                  const numericExitCode = Number(exitCode);
                  if (numericExitCode === 0) {
                    return Queue.end(queue).pipe(Effect.asVoid);
                  }
                  const detail =
                    stderrBuffer.trim() || `Watcher worker exited with code ${exitCode}.`;
                  return failQueue(detail, "workspaceFileEvents.workerExit");
                }),
                Effect.catch((cause: PlatformError.PlatformError) =>
                  released
                    ? Effect.void
                    : failQueue(
                        "Workspace file watcher worker exit status failed.",
                        "workspaceFileEvents.workerExit",
                        cause,
                      ),
                ),
                Effect.forkScoped,
              );
            }),
          { bufferSize: 64, strategy: "dropping" },
        );
      }),
    );

  return {
    watch: watchWorkspace,
  } satisfies WorkspaceFileEventsShape;
});

export const WorkspaceFileEventsLive = Layer.effect(WorkspaceFileEvents, makeWorkspaceFileEvents);
