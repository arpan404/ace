import { ClientCore } from "./client-core.ts";
import { projectCalls } from "./project-calls.ts";
import { projectEvents } from "./projects.ts";
import type { ProjectsApi } from "./projects-types.ts";
import type { ClientApi } from "./api.ts";
import type { FileDownloadInput, FileUploadInput } from "./files-types.ts";
import type { HistoryScanStatus, HistoryListRequest } from "@ace/protocol/history";
import type {
  CursorAuthEvent,
  CursorAuthRequest,
  SettingsKey,
  SettingsScope,
  SettingsLayer,
} from "@ace/protocol";
import type { Selection } from "./observable.ts";
import type { ServiceWire } from "./wire-codec.ts";
import { ClientError, type RequestOptions } from "./types.ts";

export type { RegistryQuery } from "./api.ts";
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type CursorAuthQuery = WithoutRequestId<CursorAuthRequest>;

/** Full in-process client with convenience APIs. Workers share only ClientCore. */
export class Client extends ClientCore implements ClientApi {
  attachmentBytes(input: import("./attachments.ts").AttachmentInput, options: RequestOptions = {}) {
    return import("./attachments.ts").then(({ attachmentBytes }) =>
      attachmentBytes(this, input, options),
    );
  }
  /** Project calls forward through `command`/`request`; pushes arrive through `onMessage`. */
  readonly projects: ProjectsApi = { ...projectCalls(this), ...projectEvents(this) };
  /** Ephemeral auth requests never enter the persistent intent outbox. */
  async cursorAuth(input: CursorAuthQuery, options: RequestOptions = {}): Promise<CursorAuthEvent> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const requestId = this.options.id();
    const wire = await this.service();
    const request = wire.CursorAuthRequest.parse({ ...input, requestId });
    return this.requests.wait(
      request.requestId,
      (value) => {
        const event = wire.CursorAuthEvent.parse(value);
        if (event.requestId !== request.requestId) throw new ClientError("protocol");
        return event;
      },
      options,
      () => {
        if (!this.connection.send(request)) throw new ClientError("offline");
      },
    );
  }
  historyScan(): Selection<HistoryScanStatus | undefined> {
    return this.notifications.select(["historyScan"], () => this.historyState);
  }
  scanHistory(options: RequestOptions = {}) {
    return this.historyRequest(
      { type: "history.scan", action: "start" },
      (wire) => wire.HistoryScanResponse.parse,
      options,
    );
  }
  historyScanStatus(options: RequestOptions = {}) {
    return this.historyRequest(
      { type: "history.scan", action: "status" },
      (wire) => wire.HistoryScanResponse.parse,
      options,
    );
  }
  listHistory(
    input: Omit<import("zod").input<typeof HistoryListRequest>, "type" | "requestId">,
    options: RequestOptions = {},
  ) {
    return this.historyRequest(
      { type: "history.list", ...input },
      (wire) => wire.HistoryListResponse.parse,
      options,
    );
  }
  private async historyRequest<T>(
    input:
      | import("zod").input<typeof HistoryListRequest>
      | { type: "history.scan"; action: "start" | "status" },
    decoder: (wire: ServiceWire) => (value: unknown) => T,
    options: RequestOptions,
  ): Promise<T> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const requestId = this.options.id();
    const wire = await this.service();
    const request = wire.ClientMessage.parse({ ...input, requestId });
    return this.requests.wait(requestId, decoder(wire), options, () => {
      if (!this.connection.send(request)) throw new ClientError("offline");
    });
  }
  private async read<T>(
    payload:
      | {
          type: "queue.get";
          threadId: string;
          after?: string;
          expectedRevision?: number;
          limit?: number;
        }
      | { type: "settings.get"; key: SettingsKey; scope: SettingsScope }
      | { type: "settings.set"; key: string; value: unknown; layer: SettingsLayer },
    decoder: (wire: ServiceWire) => (value: unknown) => T,
    options: RequestOptions,
  ): Promise<T> {
    if (this.state !== "ready" || this.closed) throw new ClientError("offline");
    const id = this.options.id();
    const wire = await this.service();
    const decode = decoder(wire);
    const parsed = wire.ClientMessage.safeParse({ ...payload, requestId: id });
    if (!parsed.success) throw new ClientError("protocol", "Invalid read parameters");
    return this.requests.wait(id, decode, options, () => {
      if (!this.connection.send(parsed.data)) throw new ClientError("offline");
    });
  }
  queue(threadId: string, options: RequestOptions = {}) {
    return this.queuePage({ threadId }, options);
  }
  settingsGet(key: SettingsKey, scope: SettingsScope = {}, options: RequestOptions = {}) {
    return this.read(
      { type: "settings.get", key, scope },
      (wire) => wire.SettingsResult.parse,
      options,
    );
  }
  settingsSet(key: string, value: unknown, layer: SettingsLayer, options: RequestOptions = {}) {
    return this.read(
      { type: "settings.set", key, value, layer },
      (wire) => wire.SettingsResult.parse,
      options,
    );
  }
  queuePage(
    payload: { threadId: string; after?: string; expectedRevision?: number; limit?: number },
    options: RequestOptions = {},
  ) {
    return this.read(
      { type: "queue.get", ...payload },
      (wire) => (value) => wire.QueueResult.parse(value).queue,
      options,
    );
  }
  // Transfers load on first use: the client worker starts without them (ADR 0056).
  async *downloadFile(
    input: FileDownloadInput,
    options: RequestOptions = {},
  ): AsyncGenerator<Uint8Array> {
    const { downloadFile } = await import("./files.ts");
    yield* downloadFile(this, input, options);
  }
  async uploadFile(
    input: FileUploadInput,
    source: AsyncIterable<Uint8Array>,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const { uploadFile } = await import("./files.ts");
    return uploadFile(this, input, source, options);
  }
}
