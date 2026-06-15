import { Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type GenerateNewThreadRecommendationsResult,
  type NewThreadRecommendation,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type ProviderKind,
  type ServerProvider,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetThreadError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  FilesystemBrowseError,
  ProjectCreateEntryError,
  ProjectDeleteEntryError,
  ProjectFileEventsError,
  ProjectSearchEntriesError,
  ProjectListTreeError,
  ProjectReadFileError,
  ProjectRenameEntryError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  type TerminalEvent,
  TextGenerationError,
  type BrowserBridgeRequest,
  ServerLspToolsError,
  ServerProviderCliUpgradeError,
  WorkspaceEditorCloseBufferError,
  WorkspaceEditorCompleteError,
  WorkspaceEditorDefinitionError,
  WorkspaceEditorHoverError,
  WorkspaceEditorReferencesError,
  WorkspaceEditorSyncBufferError,
  WS_METHODS,
  WsRpcGroup,
} from "@ace/contracts";
import {
  extractWebSocketAuthTokenFromProtocolHeader,
  extractWebSocketClientSessionIdFromProtocolHeader,
  extractWebSocketConnectionIdFromProtocolHeader,
} from "@ace/shared/wsAuth";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { browserBridge } from "./browserBridge";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { TextGeneration } from "./git/Services/TextGeneration";
import { resolveTextGenerationModelSelection } from "./git/textGenerationModelSelection";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import {
  sanitizeOrchestrationEventForClient,
  sanitizeReadModelForClient,
  sanitizeThreadForClient,
} from "./orchestration/publicPresentation";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ProviderService } from "./provider/Services/ProviderService";
import { startOpenCodeServer } from "./provider/opencodeRuntime";
import { OPENCODE_PROVIDER_SEARCH_PAGE_LIMIT, searchOpenCodeModels } from "./provider/opencodeSdk";
import { upgradeProviderCli, withProviderCliUpdateStatuses } from "./provider/providerCliUpgrade";
import { withProviderExtensionSlashCommands } from "./provider/providerExtensionSlashCommands";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { RelayHostManagerService } from "./relayHostManager";
import {
  getLspToolsStatus,
  installLspTool,
  installLspTools,
  searchLspMarketplace,
  uninstallLspTool,
} from "./lspTools";
import { collectRuntimeProfileSnapshot } from "./runtimeProfile";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceEditor } from "./workspace/Services/WorkspaceEditor";
import { WorkspaceFileEvents } from "./workspace/Services/WorkspaceFileEvents";
import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
} from "./workspace/Services/WorkspaceFileSystem";
import {
  WorkspacePathOutsideRootError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
} from "./workspace/Services/WorkspacePaths";
import {
  disconnectWsClientSession,
  hasActiveWsClientSessions,
  isCurrentWsClientSession,
  registerWsClientSession,
} from "./wsClientSessions";

const WS_UPGRADE_RATE_LIMIT_WINDOW_MS = 60_000;
const WS_UPGRADE_RATE_LIMIT_MAX_ATTEMPTS = 30;
const PROVIDER_AUTO_REFRESH_TICK_MS = 60_000;
const PROVIDER_AUTO_REFRESH_READY_TTL_MS = 2 * 60 * 60_000;
const PROVIDER_AUTO_REFRESH_WARNING_TTL_MS = 45 * 60_000;
const PROVIDER_AUTO_REFRESH_ERROR_TTL_MS = 15 * 60_000;
const WORKTREE_SIZE_CACHE_TTL_MS = 5 * 60_000;
const WORKTREE_SIZE_CACHE_MAX_ENTRIES = 512;
const WORKTREE_SIZE_DU_TIMEOUT_MS = 20_000;
const WORKTREE_SIZE_STATS_CONCURRENCY = 4;
const NEW_THREAD_RECOMMENDATION_CACHE_TTL_MS = 6 * 60 * 60_000;
const NEW_THREAD_RECOMMENDATION_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const NEW_THREAD_RECOMMENDATION_CACHE_CLEANUP_INTERVAL_MS = 10 * 60_000;
const NEW_THREAD_RECOMMENDATION_CACHE_MAX_FILES = 512;
const NEW_THREAD_RECOMMENDATION_GENERATION_RETRY_COOLDOWN_MS = 5 * 60_000;
const ORCHESTRATION_EVENT_REORDER_MAX_PENDING = Math.max(
  128,
  Number.parseInt(process.env.ACE_ORCHESTRATION_EVENT_REORDER_MAX_PENDING ?? "1024", 10) || 1024,
);

type WorktreeSizeStats = {
  readonly exists: boolean;
  readonly lastModifiedAt: string | null;
  readonly sizeBytes: number;
};

type WorktreeSizeCacheEntry = {
  readonly expiresAt: number;
  readonly promise: Promise<WorktreeSizeStats> | null;
  readonly value: WorktreeSizeStats | null;
};

const worktreeSizeCache = new Map<string, WorktreeSizeCacheEntry>();
let nextNewThreadRecommendationCacheCleanupAt = 0;
const newThreadRecommendationGenerationCooldownByKey = new Map<string, number>();
const execFileAsync = promisify(execFile);

type CachedNewThreadRecommendations = {
  readonly version: 1;
  readonly cacheKey: string;
  readonly cwd: string;
  readonly fingerprint: string;
  readonly generatedAt: number;
  readonly recommendations: ReadonlyArray<NewThreadRecommendation>;
};

async function getDirectorySizeBytesFromPlatform(path: string): Promise<number | null> {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$total = 0",
      "Get-ChildItem -LiteralPath $args[0] -Recurse -Force -File | ForEach-Object { $total += $_.Length }",
      "[Console]::WriteLine($total)",
    ].join("; ");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script, path],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: WORKTREE_SIZE_DU_TIMEOUT_MS,
      },
    );
    const sizeBytes = Number.parseInt(String(stdout).trim(), 10);
    return Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null;
  }

  const { stdout } = await execFileAsync("du", ["-sk", path], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: WORKTREE_SIZE_DU_TIMEOUT_MS,
  });
  const sizeKiB = Number.parseInt(String(stdout).trim().split(/\s+/)[0] ?? "", 10);
  return Number.isFinite(sizeKiB) && sizeKiB >= 0 ? sizeKiB * 1024 : null;
}

function normalizeStreamIdentity(input: {
  readonly clientSessionId?: string | undefined;
  readonly connectionId?: string | undefined;
}): {
  readonly clientSessionId: string | undefined;
  readonly connectionId: string | undefined;
} {
  return {
    clientSessionId: input.clientSessionId,
    connectionId: input.connectionId,
  };
}

function offerBrowserBridgeRequest<TError>(
  queue: Queue.Queue<BrowserBridgeRequest, TError>,
  request: BrowserBridgeRequest,
): void {
  void Effect.runPromise(Queue.offer(queue, request).pipe(Effect.asVoid));
}

function resolveWsRateLimitKey(headers: Record<string, string | undefined>): string {
  const clientSessionId = extractWebSocketClientSessionIdFromProtocolHeader(
    headers["sec-websocket-protocol"],
  );
  if (clientSessionId) {
    return `ws-client:${clientSessionId}`;
  }
  const forwardedFor = headers["x-forwarded-for"]?.split(",")[0]?.trim();
  if (forwardedFor) {
    return forwardedFor;
  }

  const realIp = headers["x-real-ip"]?.trim();
  if (realIp) {
    return realIp;
  }

  return headers["user-agent"]?.trim() || "ws-upgrade:unknown";
}

function providerRefreshJitterFactor(provider: ProviderKind): number {
  let hash = 0;
  for (let index = 0; index < provider.length; index += 1) {
    hash = (hash << 5) - hash + provider.charCodeAt(index);
    hash |= 0;
  }
  const normalized = Math.abs(hash % 100) / 100;
  return 0.8 + normalized * 0.5;
}

function providerRefreshBaseTtlMs(status: ServerProvider["status"]): number {
  switch (status) {
    case "ready":
      return PROVIDER_AUTO_REFRESH_READY_TTL_MS;
    case "warning":
      return PROVIDER_AUTO_REFRESH_WARNING_TTL_MS;
    case "error":
      return PROVIDER_AUTO_REFRESH_ERROR_TTL_MS;
    case "disabled":
      return Number.MAX_SAFE_INTEGER;
  }
}

function isPendingProviderSnapshot(provider: ServerProvider): boolean {
  return (
    provider.status === "warning" &&
    provider.message !== undefined &&
    provider.message.toLowerCase().startsWith("checking ")
  );
}

function providerRefreshDueAt(provider: ServerProvider): number {
  if (isPendingProviderSnapshot(provider)) {
    return 0;
  }
  const checkedAtMs = Date.parse(provider.checkedAt);
  const baseTtlMs = providerRefreshBaseTtlMs(provider.status);
  const ttlMs = Math.round(baseTtlMs * providerRefreshJitterFactor(provider.provider));
  if (!Number.isFinite(checkedAtMs)) {
    return 0;
  }
  return checkedAtMs + ttlMs;
}

function selectDueProviderForRefresh(
  providers: ReadonlyArray<ServerProvider>,
  now = Date.now(),
): ProviderKind | null {
  const dueProviders = providers
    .filter((provider) => provider.enabled && provider.status !== "disabled")
    .map((provider) => ({ provider: provider.provider, dueAt: providerRefreshDueAt(provider) }))
    .filter((provider) => provider.dueAt <= now);

  if (dueProviders.length === 0) {
    return null;
  }

  const oldestDueAt = dueProviders.reduce(
    (oldest, provider) => (provider.dueAt < oldest ? provider.dueAt : oldest),
    dueProviders[0]!.dueAt,
  );
  const oldestDueProviders = dueProviders.filter((provider) => provider.dueAt === oldestDueAt);
  const selectedIndex = Math.floor(Math.random() * oldestDueProviders.length);
  return oldestDueProviders[selectedIndex]?.provider ?? null;
}

function hashNewThreadRecommendationCacheKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function newThreadRecommendationCacheKey(cwd: string): string {
  return hashNewThreadRecommendationCacheKey(cwd.trim());
}

function newThreadRecommendationFingerprint(input: {
  readonly modelSelection: unknown;
  readonly turns: ReadonlyArray<unknown>;
}): string {
  return hashNewThreadRecommendationCacheKey(
    JSON.stringify({ model: input.modelSelection, turns: input.turns }),
  );
}

function newThreadRecommendationCacheDir(stateDir: string): string {
  return join(stateDir, "new-thread-recommendations");
}

function newThreadRecommendationCachePath(stateDir: string, cacheKey: string): string {
  return join(newThreadRecommendationCacheDir(stateDir), `${cacheKey}.json`);
}

function isCachedNewThreadRecommendation(value: unknown): value is NewThreadRecommendation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<NewThreadRecommendation>;
  return (
    typeof candidate.title === "string" &&
    candidate.title.trim().length > 0 &&
    typeof candidate.description === "string" &&
    candidate.description.trim().length > 0 &&
    typeof candidate.prompt === "string" &&
    candidate.prompt.trim().length > 0
  );
}

function normalizeCachedNewThreadRecommendations(
  value: unknown,
): ReadonlyArray<NewThreadRecommendation> {
  if (!Array.isArray(value)) {
    return [];
  }
  const recommendations: NewThreadRecommendation[] = [];
  const seenPrompts = new Set<string>();
  for (const item of value) {
    if (!isCachedNewThreadRecommendation(item)) {
      continue;
    }
    const prompt = item.prompt.trim().replace(/\s+/g, " ");
    if (seenPrompts.has(prompt)) {
      continue;
    }
    seenPrompts.add(prompt);
    recommendations.push({
      title: item.title.trim().replace(/\s+/g, " "),
      description: item.description.trim().replace(/\s+/g, " "),
      prompt,
    });
    if (recommendations.length >= 3) {
      break;
    }
  }
  return recommendations;
}

function isCachedNewThreadRecommendations(
  value: unknown,
  expectedCacheKey: string,
): value is CachedNewThreadRecommendations {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CachedNewThreadRecommendations>;
  return (
    candidate.version === 1 &&
    candidate.cacheKey === expectedCacheKey &&
    typeof candidate.cwd === "string" &&
    candidate.cwd.trim().length > 0 &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.generatedAt === "number" &&
    Number.isFinite(candidate.generatedAt) &&
    normalizeCachedNewThreadRecommendations(candidate.recommendations).length > 0
  );
}

function isFreshNewThreadRecommendationCache(
  cached: CachedNewThreadRecommendations,
  now: number,
): boolean {
  return now - cached.generatedAt < NEW_THREAD_RECOMMENDATION_CACHE_TTL_MS;
}

function isExpiredNewThreadRecommendationCache(
  cached: CachedNewThreadRecommendations,
  now: number,
): boolean {
  return now - cached.generatedAt >= NEW_THREAD_RECOMMENDATION_CACHE_MAX_AGE_MS;
}

async function readNewThreadRecommendationCache(
  stateDir: string,
  cwd: string,
): Promise<CachedNewThreadRecommendations | null> {
  const cacheKey = newThreadRecommendationCacheKey(cwd);
  const cachePath = newThreadRecommendationCachePath(stateDir, cacheKey);
  let raw: string;
  try {
    raw = await readFile(cachePath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await rm(cachePath, { force: true }).catch(() => {});
    return null;
  }

  if (!isCachedNewThreadRecommendations(parsed, cacheKey)) {
    await rm(cachePath, { force: true }).catch(() => {});
    return null;
  }

  const now = Date.now();
  if (isExpiredNewThreadRecommendationCache(parsed, now)) {
    await rm(cachePath, { force: true }).catch(() => {});
    return null;
  }

  return {
    ...parsed,
    recommendations: normalizeCachedNewThreadRecommendations(parsed.recommendations),
  };
}

async function writeNewThreadRecommendationCache(
  stateDir: string,
  payload: CachedNewThreadRecommendations,
): Promise<void> {
  const recommendations = normalizeCachedNewThreadRecommendations(payload.recommendations);
  const cachePath = newThreadRecommendationCachePath(stateDir, payload.cacheKey);
  if (recommendations.length === 0) {
    await rm(cachePath, { force: true }).catch(() => {});
    return;
  }

  const cacheDir = newThreadRecommendationCacheDir(stateDir);
  await mkdir(cacheDir, { recursive: true });
  const tempPath = join(cacheDir, `${payload.cacheKey}.${randomUUID()}.tmp`);
  const normalizedPayload: CachedNewThreadRecommendations = {
    ...payload,
    recommendations,
  };
  try {
    await writeFile(tempPath, `${JSON.stringify(normalizedPayload)}\n`, "utf8");
    await rename(tempPath, cachePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupNewThreadRecommendationCache(stateDir: string): Promise<void> {
  const now = Date.now();
  if (now < nextNewThreadRecommendationCacheCleanupAt) {
    return;
  }
  nextNewThreadRecommendationCacheCleanupAt =
    now + NEW_THREAD_RECOMMENDATION_CACHE_CLEANUP_INTERVAL_MS;

  const cacheDir = newThreadRecommendationCacheDir(stateDir);
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return;
  }

  const retainedEntries: Array<{ filename: string; generatedAt: number }> = [];
  await Promise.all(
    entries.map(async (filename) => {
      const filePath = join(cacheDir, filename);
      if (!filename.endsWith(".json")) {
        if (filename.endsWith(".tmp")) {
          await rm(filePath, { force: true }).catch(() => {});
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8"));
      } catch {
        await rm(filePath, { force: true }).catch(() => {});
        return;
      }

      const expectedCacheKey = filename.slice(0, -".json".length);
      if (!isCachedNewThreadRecommendations(parsed, expectedCacheKey)) {
        await rm(filePath, { force: true }).catch(() => {});
        return;
      }
      if (isExpiredNewThreadRecommendationCache(parsed, now)) {
        await rm(filePath, { force: true }).catch(() => {});
        return;
      }
      retainedEntries.push({ filename, generatedAt: parsed.generatedAt });
    }),
  );

  if (retainedEntries.length <= NEW_THREAD_RECOMMENDATION_CACHE_MAX_FILES) {
    return;
  }

  const entriesToRemove = retainedEntries
    .toSorted((left, right) => left.generatedAt - right.generatedAt)
    .slice(0, retainedEntries.length - NEW_THREAD_RECOMMENDATION_CACHE_MAX_FILES);
  await Promise.all(
    entriesToRemove.map((entry) => rm(join(cacheDir, entry.filename), { force: true })),
  );
}

async function getDirectorySizeBytes(path: string): Promise<WorktreeSizeStats> {
  let entryStat;
  try {
    entryStat = await lstat(path);
  } catch {
    return { exists: false, lastModifiedAt: null, sizeBytes: 0 };
  }

  if (!entryStat.isDirectory()) {
    return {
      exists: true,
      lastModifiedAt: new Date(entryStat.mtimeMs).toISOString(),
      sizeBytes: entryStat.size,
    };
  }

  try {
    const sizeBytes = await getDirectorySizeBytesFromPlatform(path);
    if (sizeBytes !== null) {
      return {
        exists: true,
        lastModifiedAt: new Date(entryStat.mtimeMs).toISOString(),
        sizeBytes,
      };
    }
  } catch {
    // Fall back to the directory entry stat instead of leaving storage pending forever.
  }

  return {
    exists: true,
    lastModifiedAt: new Date(entryStat.mtimeMs).toISOString(),
    sizeBytes: entryStat.size,
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  mapper: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = Array.from({ length: inputs.length }) as TOutput[];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), inputs.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputs.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(inputs[currentIndex]!);
      }
    }),
  );

  return results;
}

function pruneWorktreeSizeCache(now: number) {
  for (const [path, entry] of worktreeSizeCache) {
    if (entry.expiresAt <= now && entry.promise === null && entry.value === null) {
      worktreeSizeCache.delete(path);
    }
  }

  while (worktreeSizeCache.size > WORKTREE_SIZE_CACHE_MAX_ENTRIES) {
    const oldestPath = worktreeSizeCache.keys().next().value;
    if (typeof oldestPath !== "string") {
      break;
    }
    worktreeSizeCache.delete(oldestPath);
  }
}

function refreshCachedWorktreeSizeStats(
  path: string,
  now: number,
  cached: WorktreeSizeCacheEntry | undefined,
): Promise<WorktreeSizeStats> {
  const promise = getDirectorySizeBytes(path)
    .then((value) => {
      if (!value.exists) {
        worktreeSizeCache.delete(path);
        return value;
      }
      worktreeSizeCache.set(path, {
        expiresAt: Date.now() + WORKTREE_SIZE_CACHE_TTL_MS,
        promise: null,
        value,
      });
      return value;
    })
    .catch((error: unknown) => {
      if (cached?.value) {
        worktreeSizeCache.set(path, {
          expiresAt: Date.now() + Math.min(WORKTREE_SIZE_CACHE_TTL_MS, 60_000),
          promise: null,
          value: cached.value,
        });
      } else {
        worktreeSizeCache.delete(path);
      }
      throw error;
    });

  worktreeSizeCache.set(path, {
    expiresAt: now + WORKTREE_SIZE_CACHE_TTL_MS,
    promise,
    value: cached?.value ?? null,
  });
  return promise;
}

async function getCachedWorktreeSizeStats(path: string): Promise<WorktreeSizeStats> {
  const now = Date.now();
  const cached = worktreeSizeCache.get(path);
  if (cached?.value && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.promise) {
    return cached.promise;
  }
  if (cached?.value) {
    void refreshCachedWorktreeSizeStats(path, now, cached).catch(() => {
      // The stale value remains available until the next successful refresh or removal.
    });
    return cached.value;
  }

  pruneWorktreeSizeCache(now);
  return refreshCachedWorktreeSizeStats(path, now, cached);
}

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const keybindings = yield* Keybindings;
    const open = yield* Open;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const textGeneration = yield* TextGeneration;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const terminalManager = yield* TerminalManager;
    const providerRegistry = yield* ProviderRegistry;
    const providerServiceOption = yield* Effect.serviceOption(ProviderService);
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const relayHostManager = yield* RelayHostManagerService;
    const startup = yield* ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceEditor = yield* WorkspaceEditor;
    const workspaceFileEventsOption = yield* Effect.serviceOption(WorkspaceFileEvents);
    const workspaceFileSystem = yield* WorkspaceFileSystem;

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const settings = yield* serverSettings.getSettings;
      const providers = withProviderExtensionSlashCommands({
        providers: yield* providerRegistry.getProviders,
        cwd: config.cwd,
        settings,
      });

      return {
        cwd: config.cwd,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        availableEditors: resolveAvailableEditors(),
        settings,
        relay: yield* relayHostManager.getStatus,
      };
    });

    const withCurrentProviderCommands = (providers: ReadonlyArray<ServerProvider>) =>
      serverSettings.getSettings.pipe(
        Effect.map((settings) =>
          withProviderExtensionSlashCommands({
            providers,
            cwd: config.cwd,
            settings,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to discover provider extension commands", {
            error: error.message,
          }).pipe(Effect.as(providers)),
        ),
      );

    const generateAndCacheNewThreadRecommendations = (input: {
      readonly cwd: string;
      readonly cacheKey: string;
      readonly fingerprint: string;
      readonly modelSelection: Parameters<
        typeof textGeneration.generateNewThreadRecommendations
      >[0]["modelSelection"];
      readonly turns: Parameters<
        typeof textGeneration.generateNewThreadRecommendations
      >[0]["turns"];
    }): Effect.Effect<GenerateNewThreadRecommendationsResult, TextGenerationError> =>
      Effect.gen(function* () {
        const generated = yield* textGeneration.generateNewThreadRecommendations({
          cwd: input.cwd,
          turns: input.turns,
          modelSelection: input.modelSelection,
        });
        const recommendations = normalizeCachedNewThreadRecommendations(generated.recommendations);
        if (recommendations.length > 0) {
          yield* Effect.tryPromise({
            try: () =>
              writeNewThreadRecommendationCache(config.stateDir, {
                version: 1,
                cacheKey: input.cacheKey,
                cwd: input.cwd,
                fingerprint: input.fingerprint,
                generatedAt: Date.now(),
                recommendations,
              }),
            catch: (cause) =>
              new TextGenerationError({
                operation: "generateNewThreadRecommendations",
                detail: "Unable to write new-thread recommendation cache.",
                cause,
              }),
          }).pipe(Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.asVoid)));
        } else {
          newThreadRecommendationGenerationCooldownByKey.set(
            `${input.cacheKey}:${input.fingerprint}`,
            Date.now() + NEW_THREAD_RECOMMENDATION_GENERATION_RETRY_COOLDOWN_MS,
          );
        }
        return { recommendations };
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            newThreadRecommendationGenerationCooldownByKey.set(
              `${input.cacheKey}:${input.fingerprint}`,
              Date.now() + NEW_THREAD_RECOMMENDATION_GENERATION_RETRY_COOLDOWN_MS,
            );
          }),
        ),
      );

    const loadNewThreadRecommendations = (input: {
      readonly cwd: string;
      readonly modelSelection: Parameters<
        typeof textGeneration.generateNewThreadRecommendations
      >[0]["modelSelection"];
      readonly turns: Parameters<
        typeof textGeneration.generateNewThreadRecommendations
      >[0]["turns"];
    }): Effect.Effect<GenerateNewThreadRecommendationsResult, TextGenerationError> =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => cleanupNewThreadRecommendationCache(config.stateDir),
          catch: (cause) =>
            new TextGenerationError({
              operation: "generateNewThreadRecommendations",
              detail: "Unable to clean new-thread recommendation cache.",
              cause,
            }),
        }).pipe(Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.asVoid)));

        const cacheKey = newThreadRecommendationCacheKey(input.cwd);
        const fingerprint = newThreadRecommendationFingerprint({
          modelSelection: input.modelSelection,
          turns: input.turns,
        });
        const cached = yield* Effect.tryPromise({
          try: () => readNewThreadRecommendationCache(config.stateDir, input.cwd),
          catch: (cause) =>
            new TextGenerationError({
              operation: "generateNewThreadRecommendations",
              detail: "Unable to read new-thread recommendation cache.",
              cause,
            }),
        }).pipe(Effect.catch(() => Effect.succeed(null)));

        const cachedRecommendations =
          cached === null ? [] : normalizeCachedNewThreadRecommendations(cached.recommendations);
        const hasCachedRecommendations = cachedRecommendations.length > 0;
        const hasGenerationContext = input.turns.length > 0;

        if (
          cached !== null &&
          hasCachedRecommendations &&
          isFreshNewThreadRecommendationCache(cached, Date.now())
        ) {
          return { recommendations: cachedRecommendations };
        }

        if (!hasGenerationContext) {
          return { recommendations: cachedRecommendations };
        }

        const generationCooldownUntil =
          newThreadRecommendationGenerationCooldownByKey.get(`${cacheKey}:${fingerprint}`) ?? 0;
        if (generationCooldownUntil > Date.now()) {
          return { recommendations: cachedRecommendations };
        }
        if (generationCooldownUntil > 0) {
          newThreadRecommendationGenerationCooldownByKey.delete(`${cacheKey}:${fingerprint}`);
        }

        const refresh = generateAndCacheNewThreadRecommendations({
          ...input,
          cacheKey,
          fingerprint,
        });

        if (hasCachedRecommendations) {
          yield* refresh.pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
          return { recommendations: cachedRecommendations };
        }

        return yield* refresh;
      });

    const loadRuntimeProfile = Effect.gen(function* () {
      const providerSessions = Option.isSome(providerServiceOption)
        ? yield* providerServiceOption.value.listSessions()
        : [];
      const sessionCountByProvider = new Map<ProviderKind, number>();
      for (const session of providerSessions) {
        const currentCount = sessionCountByProvider.get(session.provider) ?? 0;
        sessionCountByProvider.set(session.provider, currentCount + 1);
      }
      const providerSessionCounts = [...sessionCountByProvider.entries()]
        .map(([provider, sessionCount]) => ({ provider, sessionCount }))
        .toSorted((left, right) => left.provider.localeCompare(right.provider));
      return collectRuntimeProfileSnapshot({
        providerSessions: providerSessionCounts,
      });
    });

    const refreshOneProviderWhenDue = Effect.gen(function* () {
      if (!hasActiveWsClientSessions()) {
        return;
      }
      const providers = yield* providerRegistry.getProviders;
      const providerToRefresh = selectDueProviderForRefresh(providers);
      if (!providerToRefresh) {
        return;
      }
      const providerServiceOption = yield* Effect.serviceOption(ProviderService);
      if (Option.isSome(providerServiceOption)) {
        const providerSessions = yield* providerServiceOption.value.listSessions();
        if (providerSessions.some((session) => session.provider === providerToRefresh)) {
          return;
        }
      }
      yield* providerRegistry.refresh(providerToRefresh);
    });

    const getProviderBinaryPath = (provider: ProviderKind, runtimeId: string) =>
      serverSettings.getSettings.pipe(
        Effect.flatMap((settings) => {
          if (runtimeId !== provider) {
            return Effect.fail(
              new ServerProviderCliUpgradeError({
                message: `Unknown ${provider} runtime '${runtimeId}'.`,
              }),
            );
          }

          switch (provider) {
            case "codex":
              return Effect.succeed(settings.providers.codex.binaryPath);
            case "claudeAgent":
              return Effect.succeed(settings.providers.claudeAgent.binaryPath);
            case "githubCopilot":
              return Effect.succeed(settings.providers.githubCopilot.binaryPath);
            case "cursor":
              return Effect.succeed(settings.providers.cursor.binaryPath);
            case "pi":
              return Effect.succeed(settings.providers.pi.binaryPath);
            case "gemini":
              return Effect.succeed(settings.providers.gemini.binaryPath);
            case "opencode":
              return Effect.succeed(settings.providers.opencode.binaryPath);
          }
        }),
        Effect.mapError(
          (cause) =>
            new ServerProviderCliUpgradeError({
              message: "Unable to read provider settings before upgrading the CLI.",
              cause,
            }),
        ),
      );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(PROVIDER_AUTO_REFRESH_TICK_MS).pipe(
          Effect.flatMap(() => refreshOneProviderWhenDue),
          Effect.ignoreCause({ log: true }),
        ),
      ),
    );

    const filterCurrentClientStream = <TValue, TError, TContext>(
      input: {
        readonly clientSessionId: string | undefined;
        readonly connectionId: string | undefined;
      },
      stream: Stream.Stream<TValue, TError, TContext>,
    ): Stream.Stream<TValue, TError, TContext> =>
      stream.pipe(
        Stream.filter(() => isCurrentWsClientSession(input.clientSessionId, input.connectionId)),
      );

    return WsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (input) =>
        projectionSnapshotQuery.getSnapshot(input).pipe(
          Effect.map(sanitizeReadModelForClient),
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load orchestration snapshot",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getShellSnapshot]: () =>
        projectionSnapshotQuery.getSnapshot({}).pipe(
          Effect.map(sanitizeReadModelForClient),
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load orchestration shell snapshot",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getThread]: (input) =>
        projectionSnapshotQuery.getThread(input.threadId).pipe(
          Effect.flatMap((thread) =>
            Option.match(thread, {
              onNone: () =>
                Effect.fail(
                  new OrchestrationGetThreadError({
                    message: `Thread '${input.threadId}' was not found.`,
                  }),
                ),
              onSome: (value) => Effect.succeed(sanitizeThreadForClient(value)),
            }),
          ),
          Effect.mapError((cause) =>
            Schema.is(OrchestrationGetThreadError)(cause)
              ? cause
              : new OrchestrationGetThreadError({
                  message: "Failed to load orchestration thread",
                  cause,
                }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
        Stream.merge(
          Stream.fromEffect(
            projectionSnapshotQuery.getSnapshot({}).pipe(
              Effect.map(sanitizeReadModelForClient),
              Effect.map((snapshot) => ({ kind: "snapshot" as const, snapshot })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
          ).pipe(Stream.catch(() => Stream.empty)),
          orchestrationEngine.streamDomainEvents.pipe(
            Stream.map(sanitizeOrchestrationEventForClient),
            Stream.map((event) => ({ kind: "event" as const, event })),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.unsubscribeShell]: () => Effect.void,
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
        Stream.merge(
          Stream.fromEffect(
            Effect.gen(function* () {
              const snapshotSequence = (yield* orchestrationEngine.getReadModel()).snapshotSequence;
              const thread = yield* projectionSnapshotQuery.getThread(input.threadId);
              return yield* Option.match(thread, {
                onNone: () =>
                  Effect.fail(
                    new OrchestrationGetThreadError({
                      message: `Thread '${input.threadId}' was not found.`,
                    }),
                  ),
                onSome: (value) =>
                  Effect.succeed({
                    kind: "snapshot" as const,
                    snapshot: {
                      snapshotSequence,
                      thread: sanitizeThreadForClient(value),
                    },
                  }),
              });
            }).pipe(
              Effect.mapError((cause) =>
                Schema.is(OrchestrationGetThreadError)(cause)
                  ? cause
                  : new OrchestrationGetThreadError({
                      message: "Failed to load orchestration thread snapshot",
                      cause,
                    }),
              ),
            ),
          ).pipe(Stream.catch(() => Stream.empty)),
          orchestrationEngine.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.aggregateKind === "thread" && event.aggregateId === input.threadId,
            ),
            Stream.map(sanitizeOrchestrationEventForClient),
            Stream.map((event) => ({ kind: "event" as const, event })),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.unsubscribeThread]: () => Effect.void,
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
        Effect.gen(function* () {
          const normalizedCommand = yield* normalizeDispatchCommand(command);
          return yield* startup.enqueueCommand(orchestrationEngine.dispatch(normalizedCommand));
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationDispatchCommandError)(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch orchestration command",
                  cause,
                }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
        checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: "Failed to load turn diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
        checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load full thread diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
        Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
          ),
        ).pipe(
          Effect.map((events) => Array.from(events).map(sanitizeOrchestrationEventForClient)),
          Effect.mapError(
            (cause) =>
              new OrchestrationReplayEventsError({
                message: "Failed to replay orchestration events",
                cause,
              }),
          ),
        ),
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const fromSequenceExclusive =
              input.fromSequenceExclusive !== undefined
                ? clamp(input.fromSequenceExclusive, {
                    maximum: Number.MAX_SAFE_INTEGER,
                    minimum: 0,
                  })
                : (yield* orchestrationEngine.getReadModel()).snapshotSequence;
            const replayStream = orchestrationEngine
              .readEvents(fromSequenceExclusive)
              .pipe(Stream.catch(() => Stream.empty));
            // Subscribe to the hot live stream at the same time as the replay stream.
            // Collecting replay first leaves a gap where events persisted after the
            // replay query but before the PubSub subscription are neither replayed
            // nor delivered live, so the browser only observes them after a later
            // snapshot refresh.
            const source = Stream.merge(replayStream, orchestrationEngine.streamDomainEvents).pipe(
              Stream.map(sanitizeOrchestrationEventForClient),
            );
            type SequenceState = {
              readonly nextSequence: number;
              readonly pendingBySequence: Map<number, OrchestrationEvent>;
            };
            const state = yield* Ref.make<SequenceState>({
              nextSequence: fromSequenceExclusive + 1,
              pendingBySequence: new Map<number, OrchestrationEvent>(),
            });

            return source.pipe(
              Stream.filter(() =>
                isCurrentWsClientSession(input.clientSessionId, input.connectionId),
              ),
              Stream.mapEffect((event) =>
                Ref.modify(
                  state,
                  ({
                    nextSequence,
                    pendingBySequence,
                  }): [Array<OrchestrationEvent>, SequenceState] => {
                    if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
                      return [[], { nextSequence, pendingBySequence }];
                    }

                    pendingBySequence.set(event.sequence, event);

                    const emit: Array<OrchestrationEvent> = [];
                    let expected = nextSequence;
                    for (;;) {
                      const expectedEvent = pendingBySequence.get(expected);
                      if (!expectedEvent) {
                        break;
                      }
                      emit.push(expectedEvent);
                      pendingBySequence.delete(expected);
                      expected += 1;
                    }

                    if (pendingBySequence.size > ORCHESTRATION_EVENT_REORDER_MAX_PENDING) {
                      let newestPendingEvent: OrchestrationEvent | null = null;
                      for (const pendingEvent of pendingBySequence.values()) {
                        if (
                          newestPendingEvent === null ||
                          pendingEvent.sequence > newestPendingEvent.sequence
                        ) {
                          newestPendingEvent = pendingEvent;
                        }
                      }
                      pendingBySequence.clear();
                      if (newestPendingEvent !== null) {
                        emit.push(newestPendingEvent);
                        expected = newestPendingEvent.sequence + 1;
                      }
                    }

                    return [emit, { nextSequence: expected, pendingBySequence }];
                  },
                ),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            );
          }),
        ),
      [WS_METHODS.serverGetConfig]: (_input) => loadServerConfig,
      [WS_METHODS.serverPickFolder]: (input) => open.pickFolder(input),
      [WS_METHODS.serverRefreshProviders]: (input) =>
        providerRegistry.refresh().pipe(
          Effect.flatMap(withCurrentProviderCommands),
          Effect.flatMap((providers) =>
            input.checkCliUpdates === true
              ? withProviderCliUpdateStatuses(providers)
              : Effect.succeed(providers),
          ),
          Effect.map((providers) => ({ providers })),
        ),
      [WS_METHODS.serverUpgradeProviderCli]: (input) =>
        Effect.gen(function* () {
          const binaryPath = yield* getProviderBinaryPath(input.provider, input.runtimeId);
          yield* upgradeProviderCli({
            provider: input.provider,
            runtimeId: input.runtimeId,
            binaryPath,
          });
          const providers = yield* providerRegistry
            .refresh(input.provider)
            .pipe(
              Effect.flatMap(withCurrentProviderCommands),
              Effect.flatMap(withProviderCliUpdateStatuses),
            );
          return { providers };
        }),
      [WS_METHODS.serverGetRuntimeProfile]: (_input) => loadRuntimeProfile,
      [WS_METHODS.serverSearchOpenCodeModels]: (input) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
          if (!settings.providers.opencode.enabled) {
            return {
              models: [],
              totalModels: 0,
              nextOffset: null,
              hasMore: false,
            };
          }

          return yield* Effect.promise(async () => {
            const server = await startOpenCodeServer(settings.providers.opencode.binaryPath);
            try {
              return await searchOpenCodeModels(server.url, {
                query: input.query,
                limit: clamp(input.limit, {
                  minimum: 1,
                  maximum: OPENCODE_PROVIDER_SEARCH_PAGE_LIMIT,
                }),
                offset: clamp(input.offset, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
              });
            } finally {
              await server.close();
            }
          }).pipe(Effect.orDie);
        }),
      [WS_METHODS.serverGenerateNewThreadRecommendations]: (input) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "generateNewThreadRecommendations",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          return yield* loadNewThreadRecommendations({
            cwd: input.cwd,
            turns: input.turns,
            modelSelection: resolveTextGenerationModelSelection({
              serverSettings: settings,
              fallbackModelSelection: input.modelSelection,
            }),
          });
        }),
      [WS_METHODS.serverGetLspToolsStatus]: (_input) =>
        Effect.tryPromise({
          try: () => getLspToolsStatus(config.stateDir),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to load language server installation status.",
              cause,
            }),
        }),
      [WS_METHODS.serverInstallLspTools]: (input) =>
        Effect.tryPromise({
          try: () =>
            installLspTools(
              config.stateDir,
              input.reinstall === undefined ? {} : { reinstall: input.reinstall },
            ),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to install language server tools.",
              cause,
            }),
        }),
      [WS_METHODS.serverSearchLspMarketplace]: (input) =>
        Effect.tryPromise({
          try: () => searchLspMarketplace(input.query, input.limit),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to search language server marketplace.",
              cause,
            }),
        }),
      [WS_METHODS.serverInstallLspTool]: (input) =>
        Effect.tryPromise({
          try: () => installLspTool(config.stateDir, input),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to install language server tool.",
              cause,
            }),
        }),
      [WS_METHODS.serverUninstallLspTool]: (input) =>
        Effect.tryPromise({
          try: () => uninstallLspTool(config.stateDir, input),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to uninstall language server tool.",
              cause,
            }),
        }),
      [WS_METHODS.serverUpsertKeybinding]: (rule) =>
        Effect.gen(function* () {
          const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
          return { keybindings: keybindingsConfig, issues: [] };
        }),
      [WS_METHODS.serverGetSettings]: (_input) => serverSettings.getSettings,
      [WS_METHODS.serverUpdateSettings]: ({ patch }) => serverSettings.updateSettings(patch),
      [WS_METHODS.serverDisconnect]: (input) =>
        Effect.sync(() => {
          disconnectWsClientSession(input.clientSessionId, input.connectionId);
          return {};
        }),
      [WS_METHODS.browserBridgeResolve]: (input) =>
        Effect.sync(() => {
          browserBridge.resolve(input);
          return {};
        }),
      [WS_METHODS.projectsSearchEntries]: (input) =>
        workspaceEntries.search(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSearchEntriesError({
                message: `Failed to search workspace entries: ${cause.detail}`,
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsListTree]: (input) =>
        workspaceEntries.listTree(input.cwd).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectListTreeError({
                message: `Failed to load workspace tree: ${cause.detail}`,
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsCreateEntry]: (input) =>
        workspaceFileSystem.createEntry(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectCreateEntryError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsDeleteEntry]: (input) =>
        workspaceFileSystem.deleteEntry(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectDeleteEntryError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsReadFile]: (input) =>
        workspaceFileSystem.readFile(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectReadFileError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsRenameEntry]: (input) =>
        workspaceFileSystem.renameEntry(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectRenameEntryError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsWriteFile]: (input) =>
        workspaceFileSystem.writeFile(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectWriteFileError({
              conflict: Schema.is(WorkspaceFileSystemError)(cause) ? cause.conflict : undefined,
              currentContents: Schema.is(WorkspaceFileSystemError)(cause)
                ? cause.currentContents
                : undefined,
              currentVersion: Schema.is(WorkspaceFileSystemError)(cause)
                ? cause.currentVersion
                : undefined,
              expectedVersion: Schema.is(WorkspaceFileSystemError)(cause)
                ? cause.expectedVersion
                : undefined,
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsFileEvents]: (input) =>
        filterCurrentClientStream(
          normalizeStreamIdentity(input),
          Option.isSome(workspaceFileEventsOption)
            ? workspaceFileEventsOption.value.watch(input.cwd).pipe(
                Stream.mapError(
                  (cause) =>
                    new ProjectFileEventsError({
                      message:
                        Schema.is(WorkspaceRootNotExistsError)(cause) ||
                        Schema.is(WorkspaceRootNotDirectoryError)(cause)
                          ? cause.message
                          : Schema.is(WorkspacePathOutsideRootError)(cause)
                            ? "Workspace file path must stay within the project root."
                            : "Workspace file watching is unavailable.",
                      cause,
                    }),
                ),
              )
            : Stream.empty,
        ),
      [WS_METHODS.workspaceEditorSyncBuffer]: (input) =>
        workspaceEditor.syncBuffer(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to sync workspace diagnostics.";
            return new WorkspaceEditorSyncBufferError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorCloseBuffer]: (input) =>
        workspaceEditor.closeBuffer(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to close the workspace diagnostics buffer.";
            return new WorkspaceEditorCloseBufferError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorComplete]: (input) =>
        workspaceEditor.complete(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to load workspace completions.";
            return new WorkspaceEditorCompleteError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorDefinition]: (input) =>
        workspaceEditor.definition(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to resolve workspace definitions.";
            return new WorkspaceEditorDefinitionError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorHover]: (input) =>
        workspaceEditor.hover(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to resolve workspace hover.";
            return new WorkspaceEditorHoverError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorReferences]: (input) =>
        workspaceEditor.references(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to resolve workspace references.";
            return new WorkspaceEditorReferencesError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.shellOpenInEditor]: (input) => open.openInEditor(input),
      [WS_METHODS.shellRevealInFileManager]: (input) => open.revealInFileManager(input),
      [WS_METHODS.shellPathExists]: (input) => open.pathExists(input),
      [WS_METHODS.shellPathInfo]: (input) => open.pathInfo(input),
      [WS_METHODS.filesystemBrowse]: (input) =>
        workspaceEntries.browse(input).pipe(
          Effect.mapError(
            (cause) =>
              new FilesystemBrowseError({
                message: cause.detail,
                cause,
              }),
          ),
        ),
      [WS_METHODS.gitStatus]: (input) => gitManager.status(input),
      [WS_METHODS.gitReadWorkingTreeDiff]: (input) => gitManager.readWorkingTreeDiff(input),
      [WS_METHODS.gitPull]: (input) => git.pullCurrentBranch(input.cwd),
      [WS_METHODS.gitRunStackedAction]: (input) =>
        Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
          gitManager
            .runStackedAction(input, {
              actionId: input.actionId,
              progressReporter: {
                publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
              },
            })
            .pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Queue.failCause(queue, cause),
                onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
              }),
            ),
        ),
      [WS_METHODS.gitResolvePullRequest]: (input) => gitManager.resolvePullRequest(input),
      [WS_METHODS.gitPreparePullRequestThread]: (input) =>
        gitManager.preparePullRequestThread(input),
      [WS_METHODS.gitListBranches]: (input) => git.listBranches(input),
      [WS_METHODS.gitGetWorktreeStats]: (input) =>
        Effect.promise(async () => {
          const uniquePaths = Array.from(new Set(input.paths));
          return {
            worktrees: await mapWithConcurrency(
              uniquePaths,
              WORKTREE_SIZE_STATS_CONCURRENCY,
              async (path) => {
                const stats = await getCachedWorktreeSizeStats(path);
                return {
                  path,
                  sizeBytes: stats.sizeBytes,
                  exists: stats.exists,
                  lastModifiedAt: stats.lastModifiedAt,
                };
              },
            ),
          };
        }),
      [WS_METHODS.gitListGitHubIssues]: (input) => gitManager.listGitHubIssues(input),
      [WS_METHODS.gitGetGitHubIssueThread]: (input) => gitManager.getGitHubIssueThread(input),
      [WS_METHODS.gitCreateWorktree]: (input) => git.createWorktree(input),
      [WS_METHODS.gitRemoveWorktree]: (input) => git.removeWorktree(input),
      [WS_METHODS.gitCreateBranch]: (input) => git.createBranch(input),
      [WS_METHODS.gitCheckout]: (input) => Effect.scoped(git.checkoutBranch(input)),
      [WS_METHODS.gitInit]: (input) => git.initRepo(input),
      [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
      [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
      [WS_METHODS.terminalResize]: (input) => terminalManager.resize(input),
      [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
      [WS_METHODS.terminalRestart]: (input) => terminalManager.restart(input),
      [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
      [WS_METHODS.terminalList]: (input) => terminalManager.list(input),
      [WS_METHODS.terminalTerminate]: (input) => terminalManager.terminate(input),
      [WS_METHODS.subscribeTerminalEvents]: (input) =>
        filterCurrentClientStream(
          normalizeStreamIdentity(input),
          Stream.callback<TerminalEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribe((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        ),
      [WS_METHODS.subscribeBrowserBridgeRequests]: (input) =>
        filterCurrentClientStream(
          normalizeStreamIdentity(input),
          Stream.callback<BrowserBridgeRequest>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                browserBridge.subscribe((request) => {
                  offerBrowserBridgeRequest(queue, request);
                }),
              ),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        ),
      [WS_METHODS.subscribeServerConfig]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const keybindingsUpdates = keybindings.streamChanges.pipe(
              Stream.map((event) => ({
                version: 1 as const,
                type: "keybindingsUpdated" as const,
                payload: {
                  issues: event.issues,
                },
              })),
            );
            const providerStatuses = providerRegistry.streamChanges.pipe(
              Stream.mapEffect(withCurrentProviderCommands),
              Stream.map((providers) => ({
                version: 1 as const,
                type: "providerStatuses" as const,
                payload: { providers },
              })),
            );
            const settingsUpdates = serverSettings.streamChanges.pipe(
              Stream.map((settings) => ({
                version: 1 as const,
                type: "settingsUpdated" as const,
                payload: { settings },
              })),
            );
            const relayUpdates = relayHostManager.streamChanges.pipe(
              Stream.map((relay) => ({
                version: 1 as const,
                type: "relayUpdated" as const,
                payload: { relay },
              })),
            );

            return filterCurrentClientStream(
              normalizeStreamIdentity(input),
              Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                Stream.merge(
                  keybindingsUpdates,
                  Stream.merge(providerStatuses, Stream.merge(settingsUpdates, relayUpdates)),
                ),
              ),
            );
          }),
        ),
      [WS_METHODS.subscribeServerLifecycle]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const snapshot = yield* lifecycleEvents.snapshot;
            const snapshotEvents = Array.from(snapshot.events).toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            const liveEvents = lifecycleEvents.stream.pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            );
            return filterCurrentClientStream(
              normalizeStreamIdentity(input),
              Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents),
            );
          }),
        ),
    });
  }),
);

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const wsUpgradeAttempts = new Map<string, { count: number; resetAt: number }>();
    const websocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup).pipe(
      Effect.provide(Layer.mergeAll(WsRpcLayer, RpcSerialization.layerJson)),
    );

    const takeWsUpgradeBudget = (clientKey: string, now = Date.now()) => {
      for (const [key, value] of wsUpgradeAttempts.entries()) {
        if (value.resetAt <= now) {
          wsUpgradeAttempts.delete(key);
        }
      }

      const current = wsUpgradeAttempts.get(clientKey);
      if (!current || current.resetAt <= now) {
        wsUpgradeAttempts.set(clientKey, {
          count: 1,
          resetAt: now + WS_UPGRADE_RATE_LIMIT_WINDOW_MS,
        });
        return {
          allowed: true,
          retryAfterSeconds: Math.ceil(WS_UPGRADE_RATE_LIMIT_WINDOW_MS / 1_000),
        } as const;
      }

      if (current.count >= WS_UPGRADE_RATE_LIMIT_MAX_ATTEMPTS) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
        } as const;
      }

      current.count += 1;
      return {
        allowed: true,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      } as const;
    };

    const releaseWsUpgradeBudget = (clientKey: string) => {
      const current = wsUpgradeAttempts.get(clientKey);
      if (!current) {
        return;
      }
      if (current.count <= 1) {
        wsUpgradeAttempts.delete(clientKey);
        return;
      }
      current.count -= 1;
    };

    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const clientKey = resolveWsRateLimitKey(request.headers);
        const rateLimit = takeWsUpgradeBudget(clientKey);
        if (!rateLimit.allowed) {
          return HttpServerResponse.text("Too many WebSocket upgrade attempts", {
            status: 429,
            headers: {
              "Retry-After": String(rateLimit.retryAfterSeconds),
            },
          });
        }
        const clientSessionId = extractWebSocketClientSessionIdFromProtocolHeader(
          request.headers["sec-websocket-protocol"],
        );
        const connectionId = extractWebSocketConnectionIdFromProtocolHeader(
          request.headers["sec-websocket-protocol"],
        );
        const connectionToken =
          extractWebSocketAuthTokenFromProtocolHeader(request.headers["sec-websocket-protocol"]) ??
          "";

        if (config.authToken) {
          if (connectionToken !== config.authToken) {
            return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
          }
        }

        if ((clientSessionId && !connectionId) || (!clientSessionId && connectionId)) {
          return HttpServerResponse.text("Invalid WebSocket client identity", { status: 400 });
        }
        releaseWsUpgradeBudget(clientKey);
        if (clientSessionId && connectionId) {
          registerWsClientSession(clientSessionId, connectionId);
        }
        return yield* websocketHttpEffect;
      }),
    );
  }),
);
