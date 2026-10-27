import { NativeTranscript, NativeTranscriptRequest } from "./native-transcript.ts";
import type { ClientCore } from "@ace/client";
import {
  AutomationRequest,
  BrowserClientMessage,
  CatalogList,
  CommandsList,
  CommandsResolve,
  HistoryListRequest,
  HistoryImportRequest,
  HistoryReleaseRequest,
  ProviderAccountsRequest,
  ProjectsRequest,
  SearchQueryRequest,
  SearchStatusRequest,
  McpProviderRequest,
  PromptFilesRequest,
  PluginClientMessage,
  ProviderLoginRequest,
  ScreenClientMessage,
  SettingsRequest,
  StorageRequest,
  SourceControlRequest,
  TerminalRequest,
  UsageSummary,
} from "@ace/protocol";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import type { CheckoutFiles } from "./checkout-files.ts";
import { NativeFilesRequest } from "./checkout-request.ts";
import { NativeAttachmentRequest, readNativeAttachment } from "./native-attachment.ts";
import { NativeMediaRequest, readNativeMedia } from "./native-media.ts";
import { NativeTerminalInputRequest, writeNativeTerminalInput } from "./native-terminal-input.ts";
import { NativeMessageRequest, readNativeMessage } from "./native-message.ts";
import { UsageLimitsRequest, readUsageLimits } from "./usage-limits.ts";
import { answerSettingsManage, SettingsManageRequest } from "./settings-manage.ts";
import { deviceFailure, NativeDeviceRequest, type NativeDevices } from "./native-devices.ts";
import { NativeScreenRequest, screenFailure, type NativeScreen } from "./native-screen.ts";
import { ForgeRequest, type ForgeService } from "./forge-service.ts";
import type { NativeReads, ReadKey, ReadTicket } from "./native-reads.ts";

// The SDK validates every request and reply. The native bridge exposes only these services;
// mutations of threads continue to go through the SDK's durable command outbox.
const Request = z.union([
  AutomationRequest,
  BrowserClientMessage,
  CatalogList,
  CommandsList,
  CommandsResolve,
  HistoryListRequest,
  HistoryImportRequest,
  HistoryReleaseRequest,
  ProviderAccountsRequest,
  ProjectsRequest,
  SearchQueryRequest,
  SearchStatusRequest,
  McpProviderRequest,
  PromptFilesRequest,
  PluginClientMessage,
  ProviderLoginRequest,
  ScreenClientMessage,
  SettingsRequest,
  StorageRequest,
  SourceControlRequest,
  TerminalRequest,
  UsageSummary,
]);
const DeviceRequestType = z.object({
  type: z.enum(["devices.request", "devices.gesture", "devices.tree"]),
});
const invalidDeviceValue = {
  message: "The device doesn't take that value.",
  hint: "Check it, such as en-US for a language, and try again.",
};
export const NativeServiceAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("service"),
    id: z.string().min(1).max(128),
    request: z.unknown(),
    /** Swift's name for a read it keeps a copy of (`native-reads.ts`). */
    cache: z.string().min(1).max(4096).optional(),
  }),
  z.object({ type: z.literal("service.cancel"), id: z.string().min(1).max(128) }),
]);

export class NativeServices {
  #pending = new Map<string, AbortController>();
  /**
   * Kept reads in flight. A screen that closes stops waiting for one, but the read finishes
   * and is kept, as the web's query cache lets a fetch finish after its view unmounts, so
   * opening the screen again draws it at once.
   */
  #keeping = new Set<string>();
  readonly transcript: NativeTranscript;
  readonly owner: ClientCore;
  readonly sink: PatchSink;
  readonly devices: NativeDevices | undefined;
  readonly screen: NativeScreen | undefined;
  readonly files: CheckoutFiles | undefined;
  readonly forge: ForgeService | undefined;
  readonly reads: NativeReads | undefined;
  constructor(
    owner: ClientCore,
    sink: PatchSink,
    devices?: NativeDevices,
    screen?: NativeScreen,
    files?: CheckoutFiles,
    forge?: ForgeService,
    reads?: NativeReads,
  ) {
    this.owner = owner;
    this.sink = sink;
    this.transcript = new NativeTranscript(owner, sink);
    this.devices = devices;
    this.screen = screen;
    this.files = files;
    this.forge = forge;
    this.reads = reads;
  }
  handle(action: z.infer<typeof NativeServiceAction>): void {
    if (action.type === "service.cancel") {
      if (!this.#keeping.has(action.id)) this.#pending.get(action.id)?.abort();
      return;
    }
    if (this.#pending.has(action.id)) return;
    const read = this.reads?.key(action.request, action.cache);
    // A kept answer younger than the web's staleTime is given again; pull to refresh never is.
    const kept = read && !refreshing(action.request) ? this.reads?.fresh(read) : undefined;
    if (read && kept !== undefined) {
      this.#reply(action.id, true, kept, "", read);
      return;
    }
    void this.#request(action.id, action.request, read);
  }
  async #request(id: string, raw: unknown, read?: ReadTicket): Promise<void> {
    const controller = new AbortController();
    if (this.#pending.size >= 32) {
      this.#reply(id, false, null, "Too many requests. Try again shortly.");
      return;
    }
    this.#pending.set(id, controller);
    if (read) this.#keeping.add(id);
    try {
      const screen = NativeScreenRequest.safeParse(raw);
      if (screen.success && this.screen) {
        try {
          const data = await this.screen.request(screen.data, controller.signal);
          this.#reply(id, true, { ok: true, data }, "");
        } catch (error) {
          this.#reply(id, true, { ok: false, error: screenFailure(error) }, "");
        }
        return;
      }
      const device = NativeDeviceRequest.safeParse(raw);
      if (device.success && this.devices) {
        try {
          const data = await this.devices.request(device.data, controller.signal);
          this.#reply(id, true, { ok: true, data }, "");
        } catch (error) {
          this.#reply(
            id,
            true,
            {
              ok: false,
              error: deviceFailure(error),
            },
            "",
          );
        }
        return;
      }
      // A device form whose value the protocol refuses (a locale, a location): say so plainly.
      if (this.devices && DeviceRequestType.safeParse(raw).success) {
        this.#reply(id, true, { ok: false, error: invalidDeviceValue }, "");
        return;
      }
      const forge = ForgeRequest.safeParse(raw);
      if (forge.success && this.forge) {
        try {
          this.#answer(id, raw, await this.forge.answer(forge.data, controller.signal), read);
        } catch (error) {
          this.#reply(id, false, null, error instanceof Error ? error.message : "");
        }
        return;
      }
      const message = NativeMessageRequest.safeParse(raw);
      if (message.success) {
        this.#reply(
          id,
          true,
          await readNativeMessage(this.owner, message.data, controller.signal),
          "",
        );
        return;
      }
      const limits = UsageLimitsRequest.safeParse(raw);
      if (limits.success) {
        this.#answer(id, raw, await readUsageLimits(this.owner, controller.signal), read);
        return;
      }
      const manage = SettingsManageRequest.safeParse(raw);
      if (manage.success) {
        this.#reply(
          id,
          true,
          await answerSettingsManage(this.owner, manage.data, controller.signal),
          "",
        );
        return;
      }
      const transcript = NativeTranscriptRequest.safeParse(raw);
      if (transcript.success) {
        this.#reply(id, true, await this.transcript.read(transcript.data, controller.signal), "");
        return;
      }
      const files = NativeFilesRequest.safeParse(raw);
      if (files.success && this.files) {
        this.#reply(id, true, await this.files.request(files.data, controller.signal), "");
        return;
      }
      const media = NativeMediaRequest.safeParse(raw);
      if (media.success) {
        this.#reply(id, true, await readNativeMedia(this.owner, media.data, controller.signal), "");
        return;
      }
      const attachment = NativeAttachmentRequest.safeParse(raw);
      if (attachment.success) {
        this.#reply(
          id,
          true,
          await readNativeAttachment(this.owner, attachment.data, controller.signal),
          "",
        );
        return;
      }
      const typed = NativeTerminalInputRequest.safeParse(raw);
      if (typed.success) {
        this.#reply(
          id,
          true,
          await writeNativeTerminalInput(this.owner, typed.data, controller.signal),
          "",
        );
        return;
      }
      const request = Request.parse({
        ...z.record(z.string(), z.unknown()).parse(raw),
        requestId: id,
      });
      // Browser's uncorrelated frame controls belong to its stream, never this request API.
      if (!("requestId" in request) || request.type === "browser.ack")
        throw new Error("Expected a request");
      const value = await this.owner.request(request, {
        signal: controller.signal,
        timeoutMs: 20_000,
      });
      this.#answer(id, raw, value, read);
    } catch {
      this.#reply(
        id,
        false,
        null,
        "Couldn't complete the request. Check the machine connection and retry.",
      );
    } finally {
      this.#pending.delete(id);
      this.#keeping.delete(id);
    }
  }
  /** A daemon answer: kept when it is a kept read, else whatever it changed is read again. */
  #answer(id: string, raw: unknown, value: unknown, read: ReadTicket | undefined): void {
    if (read) {
      this.#reply(id, true, value, "", this.reads?.answered(read, value) ? read : undefined);
      return;
    }
    this.#reply(id, true, value, "");
    this.reads?.wrote(raw);
  }
  #reply(id: string, ok: boolean, value: unknown, message: string, cache?: ReadKey): void {
    this.sink.put(`service:${id}`, () => ({
      type: "service.reply",
      id,
      ok,
      value,
      message,
      ...(cache ? { cache: { key: cache.key, family: cache.family } } : {}),
    }));
  }
}

/** Pull to refresh on the forge lists and pages reads GitHub again. */
function refreshing(request: unknown): boolean {
  return z.object({ fresh: z.literal(true) }).safeParse(request).success;
}
