import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { CursorModelMetadata, ModelCapabilities } from "./model";
import { ProviderKind, ProviderSlashCommand } from "./orchestration";
import { ServerSettings } from "./settings";
import { ServerRelayStatus } from "./relay";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderVersionStatus = Schema.Literals(["unknown", "ok", "upgrade-required"]);
export type ServerProviderVersionStatus = typeof ServerProviderVersionStatus.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isCustom: Schema.Boolean,
  capabilities: Schema.NullOr(ModelCapabilities),
  cursorMetadata: Schema.optional(CursorModelMetadata),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProvider = Schema.Struct({
  provider: ProviderKind,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  minimumVersion: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  versionStatus: Schema.optional(ServerProviderVersionStatus),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  commands: Schema.optional(Schema.Array(ProviderSlashCommand)),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerProviders = Schema.Array(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: Schema.Array(EditorId),
  settings: ServerSettings,
  relay: Schema.optional(ServerRelayStatus),
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
  relay: Schema.optional(ServerRelayStatus),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

export const ServerConfigStreamRelayUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relayUpdated"),
  payload: Schema.Struct({
    relay: ServerRelayStatus,
  }),
});
export type ServerConfigStreamRelayUpdatedEvent = typeof ServerConfigStreamRelayUpdatedEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamRelayUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerUpgradeProviderCliInput = Schema.Struct({
  provider: ProviderKind,
});
export type ServerUpgradeProviderCliInput = typeof ServerUpgradeProviderCliInput.Type;

export class ServerProviderCliUpgradeError extends Schema.TaggedErrorClass<ServerProviderCliUpgradeError>()(
  "ServerProviderCliUpgradeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerRuntimeProfileProcess = Schema.Struct({
  pid: NonNegativeInt,
  platform: TrimmedNonEmptyString,
  nodeVersion: TrimmedNonEmptyString,
  uptimeSeconds: Schema.Number,
  rssBytes: NonNegativeInt,
  heapUsedBytes: NonNegativeInt,
  heapTotalBytes: NonNegativeInt,
  externalBytes: NonNegativeInt,
  arrayBuffersBytes: NonNegativeInt,
});
export type ServerRuntimeProfileProcess = typeof ServerRuntimeProfileProcess.Type;

export const ServerRuntimeProfileSnapshotViewCache = Schema.Struct({
  maxEntries: NonNegativeInt,
  currentEntries: NonNegativeInt,
});
export type ServerRuntimeProfileSnapshotViewCache =
  typeof ServerRuntimeProfileSnapshotViewCache.Type;

export const ServerRuntimeProfileProviderRuntimeIngestionCaches = Schema.Struct({
  activeAssistantStreams: NonNegativeInt,
  assistantOutputSeenStreams: NonNegativeInt,
  pendingAssistantDeltaStreams: NonNegativeInt,
  bufferedThinkingActivities: NonNegativeInt,
  lastActivityFingerprints: NonNegativeInt,
  trackedSessionPids: NonNegativeInt,
  queueCapacity: NonNegativeInt,
});
export type ServerRuntimeProfileProviderRuntimeIngestionCaches =
  typeof ServerRuntimeProfileProviderRuntimeIngestionCaches.Type;

export const ServerRuntimeProfileCaches = Schema.Struct({
  snapshotView: ServerRuntimeProfileSnapshotViewCache,
  providerRuntimeIngestion: ServerRuntimeProfileProviderRuntimeIngestionCaches,
});
export type ServerRuntimeProfileCaches = typeof ServerRuntimeProfileCaches.Type;

export const ServerRuntimeProfileProviderSessionCount = Schema.Struct({
  provider: ProviderKind,
  sessionCount: NonNegativeInt,
});
export type ServerRuntimeProfileProviderSessionCount =
  typeof ServerRuntimeProfileProviderSessionCount.Type;

export const ServerRuntimeProfile = Schema.Struct({
  generatedAt: IsoDateTime,
  process: ServerRuntimeProfileProcess,
  caches: ServerRuntimeProfileCaches,
  providerSessions: Schema.Array(ServerRuntimeProfileProviderSessionCount),
});
export type ServerRuntimeProfile = typeof ServerRuntimeProfile.Type;

export const ServerSearchOpenCodeModelsInput = Schema.Struct({
  query: Schema.String,
  limit: NonNegativeInt,
  offset: NonNegativeInt,
});
export type ServerSearchOpenCodeModelsInput = typeof ServerSearchOpenCodeModelsInput.Type;

export const ServerSearchOpenCodeModelsResult = Schema.Struct({
  models: Schema.Array(ServerProviderModel),
  totalModels: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type ServerSearchOpenCodeModelsResult = typeof ServerSearchOpenCodeModelsResult.Type;

export const ServerLspToolId = TrimmedNonEmptyString;
export type ServerLspToolId = typeof ServerLspToolId.Type;

export const ServerLspToolSource = Schema.Literals(["builtin", "catalog", "custom"]);
export type ServerLspToolSource = typeof ServerLspToolSource.Type;

export const ServerLspToolInstaller = Schema.Literals(["npm", "uv-tool", "go-install", "rustup"]);
export type ServerLspToolInstaller = typeof ServerLspToolInstaller.Type;

export const ServerLspToolCategory = Schema.Literals([
  "core",
  "config",
  "markup",
  "framework",
  "data",
  "shell",
  "infra",
  "custom",
]);
export type ServerLspToolCategory = typeof ServerLspToolCategory.Type;

export const ServerLspToolStatus = Schema.Struct({
  id: ServerLspToolId,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  source: ServerLspToolSource,
  category: ServerLspToolCategory,
  installer: ServerLspToolInstaller,
  command: TrimmedNonEmptyString,
  args: Schema.Array(TrimmedNonEmptyString),
  packageName: TrimmedNonEmptyString,
  installPackages: Schema.Array(TrimmedNonEmptyString),
  tags: Schema.Array(TrimmedNonEmptyString),
  languageIds: Schema.Array(TrimmedNonEmptyString),
  fileExtensions: Schema.Array(TrimmedNonEmptyString),
  fileNames: Schema.Array(TrimmedNonEmptyString),
  builtin: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  binaryPath: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerLspToolStatus = typeof ServerLspToolStatus.Type;

export const ServerLspToolsStatus = Schema.Struct({
  installDir: TrimmedNonEmptyString,
  tools: Schema.Array(ServerLspToolStatus),
});
export type ServerLspToolsStatus = typeof ServerLspToolsStatus.Type;

export const ServerInstallLspToolsInput = Schema.Struct({
  reinstall: Schema.optional(Schema.Boolean),
});
export type ServerInstallLspToolsInput = typeof ServerInstallLspToolsInput.Type;

export const ServerLspMarketplaceSearchInput = Schema.Struct({
  query: Schema.String,
  limit: NonNegativeInt,
});
export type ServerLspMarketplaceSearchInput = typeof ServerLspMarketplaceSearchInput.Type;

export const ServerLspMarketplacePackage = Schema.Struct({
  packageName: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  version: Schema.NullOr(TrimmedNonEmptyString),
  keywords: Schema.Array(TrimmedNonEmptyString),
});
export type ServerLspMarketplacePackage = typeof ServerLspMarketplacePackage.Type;

export const ServerLspMarketplaceSearchResult = Schema.Struct({
  query: Schema.String,
  packages: Schema.Array(ServerLspMarketplacePackage),
});
export type ServerLspMarketplaceSearchResult = typeof ServerLspMarketplaceSearchResult.Type;

export const ServerInstallLspToolInput = Schema.Struct({
  packageName: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  installer: Schema.optional(ServerLspToolInstaller),
  description: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  installPackages: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  languageIds: Schema.Array(TrimmedNonEmptyString),
  fileExtensions: Schema.Array(TrimmedNonEmptyString),
  fileNames: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  reinstall: Schema.optional(Schema.Boolean),
});
export type ServerInstallLspToolInput = typeof ServerInstallLspToolInput.Type;

export class ServerLspToolsError extends Schema.TaggedErrorClass<ServerLspToolsError>()(
  "ServerLspToolsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
