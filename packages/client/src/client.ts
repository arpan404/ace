import { attachmentReadScope } from "./attachment-scope.ts";
import { ClientCore } from "./client-core.ts";
import { projectCalls } from "./project-calls.ts";
import { projectEvents } from "./projects.ts";
import { transfersApi, type TransfersApi } from "./transfers.ts";
import type { ProjectsApi } from "./projects-types.ts";
import type { ClientApi } from "./api.ts";
import type { FileDownloadInput, FileUploadInput } from "./files-types.ts";
import type {
  CursorAuthEvent,
  CursorAuthRequest,
  SettingsKey,
  SettingsScope,
  SettingsLayer,
} from "@ace/protocol";
import type { ServiceWire } from "./wire-codec.ts";
import { ClientError, type RequestOptions } from "./types.ts";
import { subscribeLockedUse } from "./locked-use-subscription.ts";
import type { RetryTimers } from "./settings-subscription.ts";

export type { RegistryQuery } from "./api.ts";
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type CursorAuthQuery = WithoutRequestId<CursorAuthRequest>;

/** Full in-process client with convenience APIs. Workers share only ClientCore. */
export class Client extends ClientCore implements ClientApi {
  async attachmentBytes(
    input: import("./attachments.ts").AttachmentInput,
    options: RequestOptions = {},
  ) {
    const scope = attachmentReadScope(this, options.signal);
    try {
      const { attachmentBytes } = await import("./attachments.ts");
      return await attachmentBytes(this, input, { ...options, signal: scope.signal });
    } finally {
      scope.close();
    }
  }
  /** Project calls forward through `command`/`request`; pushes arrive through `onMessage`. */
  readonly projects: ProjectsApi = { ...projectCalls(this), ...projectEvents(this) };
  /** Transfers to other machines (ADR 0101), through `command`/`request` and pushes. */
  readonly transfers: TransfersApi = transfersApi(this);
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
  /** Follow this Mac's locked computer use state; `stop()` ends it. */
  lockedUseSubscribe(
    subscriptionId: string,
    receive: (status: import("@ace/protocol").LockedUseStatus) => void,
    failed: () => void,
    timers: RetryTimers,
  ) {
    return subscribeLockedUse(this, subscriptionId, receive, failed, timers);
  }
  /** Install the locked computer use component (admin). Resolves with `lockedUse.result`. */
  lockedUseInstall(options: RequestOptions = {}) {
    return this.request({ type: "lockedUse.install" }, options);
  }
  /** Remove the locked computer use component (admin). */
  lockedUseRemove(options: RequestOptions = {}) {
    return this.request({ type: "lockedUse.remove" }, options);
  }
  /** Reinstall a drifted or failed locked computer use component (admin). */
  lockedUseRepair(options: RequestOptions = {}) {
    return this.request({ type: "lockedUse.repair" }, options);
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
