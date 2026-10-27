export type { RegistryQuery } from "./api.ts";
export type { CursorAuthQuery } from "./client.ts";
export { Client } from "./client.ts";
export { ClientCore } from "./client-core.ts";
export { commandAdmissionError, type CommandAdmissionEvidence } from "./command-admission.ts";
export { ClientError, defaultLimits } from "./types.ts";
export type {
  ClientOptions,
  ConnectionState,
  ConnectionInfo,
  ConnectionClose,
  DiagnosticEvent,
  Transport,
  TransportEvents,
  Storage,
  IntentRecords,
  Scheduler,
  Limits,
  RequestOptions,
  TextReadOptions,
} from "./types.ts";
export { webSocketTransport } from "./transport.ts";
export type { BrowserFrameBytes, StreamMessage } from "@ace/browser/stream";
export type { SocketLike } from "./transport.ts";
export type { Selection, ChangeTap } from "./observable.ts";
export { Notifications } from "./observable.ts";
export type {
  ClientApi,
  ClientCoreApi,
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
/** Transcript order: dedupe by id, order by the daemon's creation sequence (ADR 0062). */
export { mergeBySeq } from "@ace/projection";
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
export { accessResponseError } from "./access-http.ts";
export { PermissionClient, threadPermission, accessModes } from "./permissions.ts";
export { oppositeFollowUpBehavior } from "./follow-up.ts";
export { retrySend } from "./send-retry.ts";
export { readServerQueue } from "./queue-read.ts";
export { subscribeSettings } from "./settings-subscription.ts";
export { subscribeLockedUse } from "./locked-use-subscription.ts";
export type { LockedUseOwner } from "./locked-use-subscription.ts";
export type { RetryTimers, SettingsOwner } from "./settings-subscription.ts";

export { BrowserFeaturesClient } from "./browser-features.ts";
export { deviceDownloadMax, fetchBrowserDownload } from "./browser-download.ts";
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

export {
  connectionLost,
  downloadFile,
  sendResumableUpload,
  uploadFile,
  type ResumableUpload,
} from "./files.ts";
export {
  readFile,
  type FileReadInput,
  type FileReadOutcome,
  type FileReader,
} from "./file-read.ts";
export type { FileDownloadInput, FileUploadInput } from "./files-types.ts";

export {
  TransferError,
  TransferStore,
  followTransfers,
  type TransfersSource,
  cancellablePhases,
  continueBlocked,
  transferCancellable,
  transferRunning,
  transfersApi,
  type TransfersApi,
} from "./transfers.ts";
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

export { ModelClient, scopedSelection } from "./models.ts";
export type { CommandSelection, ModelScope, ModelServicePort } from "./models.ts";

export { attachmentBytes, type AttachmentInput } from "./attachments.ts";
export { pendingSend, pendingSendsEqual, matchesPendingThread } from "./pending-sends.ts";
export type { PendingSend, SendPayload } from "./pending-sends.ts";

export { fitsUtf8 } from "./bounds.ts";

export { attachmentReadScope } from "./attachment-scope.ts";

export type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";

export { windowSource, type ThreadWindow } from "./window-source.ts";
