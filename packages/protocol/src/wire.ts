import { ProviderAccountsRequest, ProviderAccountsResult } from "./provider-accounts.ts";
import {
  ProviderInstallRequest,
  ProviderInstallResult,
  ProviderInstallEvent,
} from "./provider-install.ts";
import {
  ProviderLoginRequest,
  ProviderLoginResult,
  ProviderLoginEvent,
  OnboardingRequest,
  OnboardingResult,
  ProvidersChanged,
} from "./provider-login.ts";
import { ActivityReadsChanged, ActivityReadsRequest, ActivityReadsResult } from "./activity.ts";
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
  HostIdentityRequest,
  HostIdentityResult,
  MachinesRequest,
  MachinesResult,
} from "./machines.ts";
import { PreviewRequest, PreviewResult } from "./preview-client.ts";
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
import { DiagnosticsHealthRequest, DiagnosticsHealthResult } from "./diagnostics.ts";
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
  CommandResult,
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
  HistoryScanRequest,
  HistoryScanResponse,
  HistoryScanUpdated,
  HistoryContinueRequest,
  HistoryContinueResponse,
} from "./history.ts";
import { McpProviderRequest, McpProviderResult } from "./mcp.ts";
import {
  UsageSummary,
  UsageSeries,
  UsageMessage,
  UsageSessionTotals,
  UsageSessionTotalsMessage,
} from "./usage.ts";
import { CursorAuthRequest, CursorAuthEvent } from "./cursor-auth.ts";
import { AccountsRequest, AccountsResponse } from "./accounts.ts";
import { DeviceClientMessage, DeviceServerMessage } from "./devices.ts";
import { ScreenClientMessage, ScreenServerMessage } from "./screen.ts";
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
  NotificationSettings,
  NotificationSnooze,
  NotificationMessage,
} from "./notifications.ts";

import {
  SettingsGet,
  SettingsSet,
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
  TurnsPageRequest,
  ItemsWindowRequest,
  ThreadSearchRequest,
  ThreadCatchUpRequest,
  ThreadReadStateRequest,
  HostIdentityRequest,
  MachinesRequest,
  ProvidersRequest,
  ...ProviderLoginRequest.options,
  ...ProviderInstallRequest.options,
  ...OnboardingRequest.options,
  PreviewRequest,
  ...AutomationRequest.options,
  ...ActivityReadsRequest.options,
  QueueGet,
  PiControlRequest,

  RegistryRequest,
  WorkspaceActionRequest,
  ProjectsRequest,
  TerminalRequest,
  TerminalCredit,
  PluginClientMessage,
  DiagnosticsHealthRequest,
  PermissionCapabilitiesRequest,
  ContextRequest,
  SettingsGet,
  SettingsSet,
  SettingsSubscribe,
  SettingsUnsubscribe,
  HistoryListRequest,
  HistoryImportRequest,
  HistoryScanRequest,
  HistoryContinueRequest,
  McpProviderRequest,
  UsageSummary,
  UsageSeries,
  UsageSessionTotals,
  ...FilesClientMessage.options,
  CommandsList,
  CommandsResolve,
  ...AccountsRequest.options,
  ...ProviderAccountsRequest.options,
  ...CursorAuthRequest.options,
  SearchQueryRequest,
  SearchStatusRequest,
  ScreenClientMessage,
  DeviceClientMessage,
  ...BrowserClientMessage.options,
  ModelsListRequest,
  ModelsRefreshRequest,
  ModelsResolveRequest,
  PresenceUpdate,
  NotificationRegister,
  NotificationSettings,
  NotificationSnooze,

  ...CoreClientMessage.options,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const ServerMessage = z.discriminatedUnion("type", [
  TurnsPageResponse,
  ItemsWindowResponse,
  ThreadSearchResponse,
  ThreadCatchUpResponse,
  ThreadReadStateResponse,
  HostIdentityResult,
  MachinesResult,
  ProvidersResult,
  ProviderLoginResult,
  ProviderLoginEvent,
  ProviderInstallResult,
  ProviderInstallEvent,
  OnboardingResult,
  ProvidersChanged,
  PreviewResult,
  AutomationResponse,
  ActivityReadsResult,
  ActivityReadsChanged,
  QueueResult,
  PiControlResult,

  RegistryResult,
  WorkspaceActionResult,
  ProjectsResult,
  WorkspaceChanged,
  WorkspaceCloneProgress,
  TerminalResult,
  TerminalOutput,
  PluginServerMessage,
  DiagnosticsHealthResult,
  PermissionCapabilitiesResult,
  ContextResult,
  SettingsResult,
  SettingsChanged,
  SettingsDiagnosticMessage,
  HistoryListResponse,
  HistoryImportResponse,
  HistoryScanResponse,
  HistoryScanUpdated,
  HistoryOperationProgress,
  HistoryContinueResponse,
  McpProviderResult,
  UsageMessage,
  UsageSessionTotalsMessage,
  ...FilesServerMessage.options,
  CommandsListResult,
  CommandsResolveResult,
  ...AccountsResponse.options,
  ProviderAccountsResult,
  ...CursorAuthEvent.options,
  SearchQueryResponse,
  SearchStatusResponse,
  SearchErrorResponse,
  ...ScreenServerMessage.options,
  ...DeviceServerMessage.options,
  ...BrowserServerMessage.options,
  ModelsResult,
  ModelsChanged,
  NotificationMessage,
  ...CoreServerMessage.options,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type EventBatch = Extract<ServerMessage, { type: "events" }>;
export type Progress = Extract<ServerMessage, { type: "progress" }>;
