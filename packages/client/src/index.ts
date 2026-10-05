export type { RegistryQuery } from "./api.ts";
export type { CursorAuthQuery } from "./client.ts";
export { Client } from "./client.ts";
export { ClientError, defaultLimits } from "./types.ts";
export type {
  ClientOptions,
  ConnectionState,
  ConnectionInfo,
  Transport,
  TransportEvents,
  Storage,
  Scheduler,
  Limits,
  RequestOptions,
} from "./types.ts";
export { webSocketTransport } from "./transport.ts";
export type { SocketLike } from "./transport.ts";
export type { Selection, ChangeTap } from "./observable.ts";
export { Notifications } from "./observable.ts";
export type {
  ClientApi,
  ConnectionControl,
  ThreadSource,
  SidebarSource,
  Lease,
  OutputData,
  ThreadExport,
  SidebarExport,
  Mirrorable,
} from "./api.ts";
export { ThreadStore } from "./thread-store.ts";
export type { ThreadReader, ThreadKey } from "./thread-store.ts";
export type { ThreadSubscription } from "./subscriptions.ts";
export type { Intent } from "./intents.ts";
export type { Sidebar } from "./sidebar.ts";
export type { SidebarKey, SidebarReader } from "./readers.ts";
export { ticketCredential } from "./credentials.ts";
export type { Credential } from "./credentials.ts";
export { retryDelay } from "./lifecycle.ts";
export { rootProviderControls, childProviderControls } from "./provider-controls.ts";
export type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
export { isOneWayMessage } from "./one-way.ts";
export type { OneWayMessage } from "./one-way.ts";
export { AccessClient } from "./access.ts";
export type { AccessOptions } from "./access.ts";
export {
  PermissionClient,
  threadPermission,
  permissionModes,
  permissionGuarantee,
  permissionReview,
} from "./permissions.ts";
export { oppositeFollowUpBehavior } from "./follow-up.ts";

export { ConductorClient } from "./conductor.ts";
export { BrowserOriginsClient } from "./browser-origins.ts";
export type { ConductorWatch } from "./conductor.ts";
export { DeviceClient, DeviceClientError } from "@ace/devices/client";
export type {
  DeviceClientSnapshot,
  DeviceLogBatch,
  DeviceTransport,
  DeviceClientOptions,
} from "@ace/devices/client";
export { deviceTransport, authenticatedChannel } from "./device-transport.ts";
export type { AuthenticatedChannelOptions, DeviceConnectionTarget } from "./device-transport.ts";
export { downloadArtifact } from "@ace/files/client";
export type { ArtifactChannel, ArtifactSink } from "@ace/files/client";

export { downloadFile, uploadFile } from "./files.ts";
export type { FileDownloadInput, FileUploadInput } from "./files-types.ts";

export { deferredProjectsApi, type ProjectsApi, type ProjectCallsModule } from "./projects.ts";
export { loadServiceWire, type ServiceWire } from "./wire-codec.ts";
export type {
  TurnsPageInput,
  ItemsWindowInput,
  ThreadSearchInput,
  ThreadCatchUpInput,
  ThreadReadStateInput,
  ThreadMarkReadInput,
} from "./long-thread.ts";
