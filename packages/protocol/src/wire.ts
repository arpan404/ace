import { CliRequest, CliResult } from "./cli-control.ts";
import { StorageRequest, StorageResult } from "./storage.ts";
import { UserBrowserSettings, UserBrowserSettingsResult } from "./user-browser.ts";
import { HostedRepositoriesRequest, HostedRepositoriesResult } from "./hosted-repositories.ts";
import { SourceControlRequest, SourceControlResult } from "./source-control.ts";
import { PromptFilesRequest, PromptFilesResponse } from "./prompt-files.ts";
import { ProviderAccountsRequest, ProviderAccountsResult } from "./provider-accounts.ts";
import {
  ProviderInstallRequest,
  ProviderInstallResult,
  ProviderInstallEvent,
} from "./provider-install.ts";
import {
  WorktreeCreationRequest,
  WorktreeCreationEvent,
  WorktreeCreationResult,
} from "./worktree-creation.ts";
import {
  CatalogList,
  CatalogUnsubscribe,
  CatalogListResult,
  CatalogChanged,
} from "./extension-catalog.ts";
import {
  ProviderLoginRequest,
  ProviderLoginResult,
  ProviderLoginEvent,
  OnboardingRequest,
  OnboardingResult,
  ProvidersChanged,
} from "./provider-login.ts";
import { ActivityReadsChanged, ActivityReadsRequest, ActivityReadsResult } from "./activity.ts";
import { VerifyChanged, VerifyRequest, VerifyResult } from "./pr-verify.ts";
import { ProvidersRequest, ProvidersResult } from "./provider-status.ts";
import {
  ProjectsRequest,
  ProjectsResult,
  WorkspaceChanged,
  WorkspaceCloneProgress,
} from "./project-requests.ts";
import {
  TurnsPageRequest,
  TurnsPageResponse,
  ItemsWindowRequest,
  ItemsWindowResponse,
  ThreadSearchRequest,
  ThreadSearchResponse,
  ThreadCatchUpRequest,
  ThreadCatchUpResponse,
  ThreadReadStateRequest,
  ThreadReadStateResponse,
} from "./long-thread.ts";
import {
  TurnStepsRequest,
  TurnStepsResponse,
  IconsResolveRequest,
  IconsResolveResponse,
  IconsReadRequest,
  IconsReadResponse,
} from "./turn-steps.ts";
import { AvatarsResolveRequest, AvatarsResolveResponse } from "./avatars.ts";
import {
  HostIdentityRequest,
  HostIdentityResult,
  MachinesRequest,
  MachinesResult,
} from "./machines.ts";
import { FleetRequest, FleetResult } from "./fleet.ts";
import { PreviewRequest, PreviewResult, PreviewSuggestions } from "./preview-client.ts";
import { AutomationRequest, AutomationResponse } from "./automations.ts";
import {
  TerminalRequest,
  TerminalCredit,
  TerminalResult,
  TerminalOutput,
} from "./terminal-client.ts";
import { WorkspaceActionRequest, WorkspaceActionResult } from "./workspace-actions.ts";
import { PluginClientMessage, PluginServerMessage } from "./plugins.ts";
import { BrowserClientMessage, BrowserServerMessage } from "./browser.ts";
import { BrowserBrowsing, BrowserBrowsingWatch } from "./browser-browsing.ts";
import { ComputerUsing, ComputerUsingWatch } from "./computer-using.ts";
import {
  DiagnosticsHealthRequest,
  DiagnosticsHealthResult,
  DiagnosticsRequest,
  DiagnosticsResult,
} from "./diagnostics.ts";
import { PiControlRequest, PiControlResult } from "./pi.ts";
import {
  PermissionCapabilitiesRequest,
  PermissionCapabilitiesResult,
} from "./permission-client.ts";
import { RegistryRequest, RegistryResult } from "./agent-registry.ts";
import { FilesClientMessage, FilesServerMessage } from "./files.ts";
import {
  CommandsList,
  CommandsResolve,
  CommandsListResult,
  CommandsResolveResult,
} from "./command-library.ts";
import { z } from "zod";
import { CoreClientMessage, CoreServerMessage } from "./wire-core.ts";

// The core stream lives in wire-core.ts so a client can decode it alone and load the service
// families later.
export {
  ThreadListCursor,
  ThreadListWindow,
  CommandResult,
  CommandStatusState,
  CoreClientMessage,
  CoreServerMessage,
  coreClientTypes,
  coreServerTypes,
  DeliveryEvent,
  ItemsPage,
  EntitiesPage,
  EntityCollection,
  SnapshotView,
  SubscriptionScope,
  ThreadListEntry,
  ThreadListView,
  ThreadView,
} from "./wire-core.ts";
import { QueueGet, QueueResult } from "./queue.ts";
import { ContextRequest, ContextResult } from "./context.ts";
import {
  HistoryOperationProgress,
  HistoryListRequest,
  HistoryListResponse,
  HistoryImportRequest,
  HistoryImportResponse,
  HistoryReleaseRequest,
  HistoryReleaseResponse,
  HistoryContinueRequest,
  HistoryContinueResponse,
} from "./history.ts";
import { McpProviderRequest, McpProviderResult } from "./mcp.ts";
import {
  UsageSummary,
  UsageSeries,
  UsageMessage,
  UsageLimitsChanged,
  UsageSessionTotals,
  UsageSessionTotalsMessage,
} from "./usage.ts";
import { CursorAuthRequest, CursorAuthEvent } from "./cursor-auth.ts";
import { AccountsRequest, AccountsResponse } from "./accounts.ts";
import { DeviceAck, DeviceClientMessage, DeviceServerMessage } from "./devices.ts";
import { ScreenAck, ScreenClientMessage, ScreenServerMessage } from "./screen.ts";
import {
  ModelsListRequest,
  ModelsRefreshRequest,
  ModelsResolveRequest,
  ModelsResult,
  ModelsChanged,
} from "./models.ts";
import {
  PresenceUpdate,
  NotificationRegister,
  NotificationRegisterResult,
  NotificationUnregister,
  NotificationUnregisterResult,
  NotificationConfigRequest,
  NotificationConfigResult,
  NotificationSettings,
  NotificationSnooze,
  NotificationMessage,
  NotificationFeedRequest,
  NotificationFeedResult,
} from "./notifications.ts";

import {
  SettingsGet,
  SettingsSet,
  SettingsReset,
  SettingsSubscribe,
  SettingsUnsubscribe,
  SettingsResult,
  SettingsChanged,
  SettingsDiagnosticMessage,
} from "./settings.ts";
import {
  SearchQueryRequest,
  SearchStatusRequest,
  SearchQueryResponse,
  SearchStatusResponse,
  SearchErrorResponse,
} from "./search.ts";

export const ClientMessage = z.discriminatedUnion("type", [
  CliRequest,
  StorageRequest,
  UserBrowserSettings,
  WorktreeCreationRequest,
  TurnsPageRequest,
  ItemsWindowRequest,
  TurnStepsRequest,
  IconsResolveRequest,
  IconsReadRequest,
  AvatarsResolveRequest,
  ThreadSearchRequest,
  ThreadCatchUpRequest,
  ThreadReadStateRequest,
  HostIdentityRequest,
  MachinesRequest,
  FleetRequest,
  ProvidersRequest,
  ...ProviderLoginRequest.options,
  ...ProviderInstallRequest.options,
  ...OnboardingRequest.options,
  PreviewRequest,
  ...AutomationRequest.options,
  ...ActivityReadsRequest.options,
  VerifyRequest,
  QueueGet,
  PiControlRequest,

  RegistryRequest,
  WorkspaceActionRequest,
  ProjectsRequest,
  SourceControlRequest,
  HostedRepositoriesRequest,
  TerminalRequest,
  TerminalCredit,
  PluginClientMessage,
  DiagnosticsHealthRequest,
  DiagnosticsRequest,
  PermissionCapabilitiesRequest,
  ContextRequest,
  SettingsGet,
  SettingsSet,
  SettingsReset,
  SettingsSubscribe,
  SettingsUnsubscribe,
  HistoryListRequest,
  HistoryImportRequest,
  HistoryReleaseRequest,
  HistoryContinueRequest,
  McpProviderRequest,
  UsageSummary,
  UsageSeries,
  UsageSessionTotals,
  ...FilesClientMessage.options,
  CommandsList,
  CommandsResolve,
  PromptFilesRequest,
  CatalogList,
  CatalogUnsubscribe,
  ...AccountsRequest.options,
  ...ProviderAccountsRequest.options,
  ...CursorAuthRequest.options,
  SearchQueryRequest,
  SearchStatusRequest,
  ScreenClientMessage,
  ScreenAck,
  DeviceClientMessage,
  DeviceAck,
  ...BrowserClientMessage.options,
  BrowserBrowsingWatch,
  ComputerUsingWatch,
  ModelsListRequest,
  ModelsRefreshRequest,
  ModelsResolveRequest,
  PresenceUpdate,
  NotificationRegister,
  NotificationUnregister,
  NotificationConfigRequest,
  NotificationSettings,
  NotificationSnooze,
  NotificationFeedRequest,

  ...CoreClientMessage.options,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const ServerMessage = z.discriminatedUnion("type", [
  CliResult,
  StorageResult,
  UserBrowserSettingsResult,
  WorktreeCreationEvent,
  WorktreeCreationResult,
  TurnsPageResponse,
  ItemsWindowResponse,
  TurnStepsResponse,
  IconsResolveResponse,
  IconsReadResponse,
  AvatarsResolveResponse,
  ThreadSearchResponse,
  ThreadCatchUpResponse,
  ThreadReadStateResponse,
  HostIdentityResult,
  MachinesResult,
  FleetResult,
  ProvidersResult,
  ProviderLoginResult,
  ProviderLoginEvent,
  ProviderInstallResult,
  ProviderInstallEvent,
  OnboardingResult,
  ProvidersChanged,
  PreviewResult,
  PreviewSuggestions,
  AutomationResponse,
  ActivityReadsResult,
  ActivityReadsChanged,
  VerifyResult,
  VerifyChanged,
  QueueResult,
  PiControlResult,

  RegistryResult,
  WorkspaceActionResult,
  ProjectsResult,
  SourceControlResult,
  HostedRepositoriesResult,
  WorkspaceChanged,
  WorkspaceCloneProgress,
  TerminalResult,
  TerminalOutput,
  PluginServerMessage,
  DiagnosticsHealthResult,
  DiagnosticsResult,
  PermissionCapabilitiesResult,
  ContextResult,
  SettingsResult,
  SettingsChanged,
  SettingsDiagnosticMessage,
  HistoryListResponse,
  HistoryImportResponse,
  HistoryReleaseResponse,
  HistoryOperationProgress,
  HistoryContinueResponse,
  McpProviderResult,
  UsageMessage,
  UsageLimitsChanged,
  UsageSessionTotalsMessage,
  ...FilesServerMessage.options,
  CommandsListResult,
  CommandsResolveResult,
  PromptFilesResponse,
  CatalogListResult,
  CatalogChanged,
  ...AccountsResponse.options,
  ProviderAccountsResult,
  ...CursorAuthEvent.options,
  SearchQueryResponse,
  SearchStatusResponse,
  SearchErrorResponse,
  ...ScreenServerMessage.options,
  ...DeviceServerMessage.options,
  ...BrowserServerMessage.options,
  BrowserBrowsing,
  ComputerUsing,
  ModelsResult,
  ModelsChanged,
  NotificationConfigResult,
  NotificationMessage,
  NotificationFeedResult,
  NotificationRegisterResult,
  NotificationUnregisterResult,
  ...CoreServerMessage.options,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type EventBatch = Extract<ServerMessage, { type: "events" }>;
export type Progress = Extract<ServerMessage, { type: "progress" }>;
