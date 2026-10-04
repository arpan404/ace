import type { PendingSend } from "./pending-sends.ts";
import type { ProjectsApi } from "./projects-types.ts";
import type {
  TurnsPageInput,
  ItemsWindowInput,
  ThreadSearchInput,
  ThreadCatchUpInput,
  ThreadReadStateInput,
  ThreadMarkReadInput,
} from "./long-thread.ts";
import type {
  TurnsPageResponse,
  ItemsWindowResponse,
  ThreadSearchResponse,
  ThreadCatchUpResponse,
  ThreadReadStateResponse,
  CommandPayload,
  CommandResult,
  RegistryRequest,
  ItemsPage,
  RegistryResult,
  ServerMessage,
  TextSource,
  ThreadListView,
  ThreadView,
} from "@ace/protocol";
import type { FileDownloadInput, FileUploadInput } from "./files-types.ts";
import type { Intent } from "./intents.ts";
import type { OneWayMessage } from "./one-way.ts";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import type { ChangeTap, Selection } from "./observable.ts";
import type { SidebarKey, SidebarReader, ThreadKey, ThreadReader } from "./readers.ts";
import type { ClientError, ConnectionState, RequestOptions } from "./types.ts";

/*
 * The surface UI code depends on. `Client` implements it in-process; a client running in a
 * worker implements it in the page from forwarded changes (ADR 0056). Readers stay synchronous
 * either way: a selector always reads a local copy.
 */

/** A thread's live state with keyed change notification. */
export interface ThreadSource extends ThreadReader {
  select<T>(
    keys: readonly ThreadKey[],
    selector: (reader: ThreadReader) => T,
    equal?: (a: T, b: T) => boolean,
  ): Selection<T>;
}
/** The thread list with keyed change notification. */
export interface SidebarSource extends SidebarReader {
  select<T>(
    keys: readonly SidebarKey[],
    read: (sidebar: SidebarReader) => T,
    equal?: (a: T, b: T) => boolean,
  ): Selection<T>;
}
export interface Lease<T> {
  store: T;
  release(): void;
}
export type OutputData = Omit<Extract<ServerMessage, { type: "output.data" }>, "bytes"> & {
  bytes: Uint8Array;
};
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type RegistryQuery = WithoutRequestId<RegistryRequest>;

export interface ClientApi {
  readonly projects: ProjectsApi;
  readonly state: ConnectionState;
  readonly error: ClientError | undefined;
  connectionState(): Selection<ConnectionState>;
  intent(id: string): Selection<Intent | undefined>;
  pendingSends(threadId?: string): Selection<readonly PendingSend[]>;
  start(): Promise<void>;
  close(): Promise<void>;
  networkOnline(online: boolean): void;
  thread(id: string): Lease<ThreadSource>;
  threads(): Lease<SidebarSource>;
  enqueue(payload: CommandPayload, id?: string): Promise<string>;
  command(payload: CommandPayload, options?: RequestOptions, id?: string): Promise<CommandResult>;
  registry(input: RegistryQuery, options?: RequestOptions): Promise<RegistryResult>;
  /** One-off service operation (ADR 0052). Never persisted or replayed after a disconnect. */
  request<Q extends ServiceRequest>(
    input: Q,
    options?: RequestOptions,
  ): Promise<ServiceResponse<Q>>;
  /** Uncorrelated service messages (such as `settings.changed`); call the result to stop. */
  onMessage(listener: (message: ServerMessage) => void): () => void;
  /**
   * One-way service controls (a browser frame ACK, a terminal credit). Never queued or replayed:
   * throws `offline` unless connected and `protocol` for a message that isn't one-way.
   */
  send(message: OneWayMessage): void;
  downloadFile(input: FileDownloadInput, options?: RequestOptions): AsyncGenerator<Uint8Array>;
  uploadFile(
    input: FileUploadInput,
    source: AsyncIterable<Uint8Array>,
    options?: RequestOptions,
  ): Promise<unknown>;
  turnsPage(input: TurnsPageInput, options?: RequestOptions): Promise<TurnsPageResponse>;
  /** A bounded jumped window. Never changes the leased live tail. */
  itemsWindow(input: ItemsWindowInput, options?: RequestOptions): Promise<ItemsWindowResponse>;
  threadSearch(input: ThreadSearchInput, options?: RequestOptions): Promise<ThreadSearchResponse>;
  threadCatchUp(
    input: ThreadCatchUpInput,
    options?: RequestOptions,
  ): Promise<ThreadCatchUpResponse>;
  threadReadState(
    input: ThreadReadStateInput,
    options?: RequestOptions,
  ): Promise<ThreadReadStateResponse>;
  /** Coalesce read updates per thread. Never persisted or replayed through the outbox. */
  markThreadRead(input: ThreadMarkReadInput, options?: RequestOptions): Promise<CommandResult>;
  itemsPage(
    payload: { threadId: string; before?: number | undefined; limit: number },
    options?: RequestOptions,
  ): Promise<ItemsPage>;
  /** Fetch the page before a leased thread's window and merge it into that thread's store. */
  loadOlder(threadId: string, limit: number, options?: RequestOptions): Promise<void>;
  outputRead(
    payload: { streamId: string; offset: number; limit: number },
    options?: RequestOptions,
  ): Promise<OutputData>;
  text(source: TextSource, options?: RequestOptions): AsyncGenerator<string>;
  output(
    payload: { streamId: string; offset: number; limit: number },
    options?: RequestOptions,
  ): AsyncGenerator<Uint8Array>;
}

/** Everything a thread store holds, for copying it to another realm in one message. */
export interface ThreadExport {
  error: { code: ClientError["code"]; message: string } | undefined;
  view: Omit<ThreadView, "itemSeqs" | "kind"> | undefined;
  truncated: string[];
}
export interface SidebarExport {
  error: { code: ClientError["code"]; message: string } | undefined;
  view: ThreadListView | undefined;
  ids: readonly string[];
}
/** A store that can be mirrored: read whole, then follow its change keys. */
export interface Mirrorable<E> {
  observe(tap: ChangeTap): () => void;
  export(): E;
}
