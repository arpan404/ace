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
import { NativeMediaRequest, readNativeMedia } from "./native-media.ts";
import { NativeHistoryWindow, readHistoryWindow } from "./native-search.ts";
import { NativeMessageRequest, readNativeMessage } from "./native-message.ts";
import { NativeDeviceRequest, type NativeDevices } from "./native-devices.ts";
import { NativeScreenRequest, type NativeScreen } from "./native-screen.ts";

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
export const NativeServiceAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("service"), id: z.string().min(1).max(128), request: z.unknown() }),
  z.object({ type: z.literal("service.cancel"), id: z.string().min(1).max(128) }),
]);

export class NativeServices {
  #pending = new Map<string, AbortController>();
  readonly transcript: NativeTranscript;
  readonly owner: ClientCore;
  readonly sink: PatchSink;
  readonly devices: NativeDevices | undefined;
  readonly screen: NativeScreen | undefined;
  constructor(owner: ClientCore, sink: PatchSink, devices?: NativeDevices, screen?: NativeScreen) {
    this.owner = owner;
    this.transcript = new NativeTranscript(owner);
    this.sink = sink;
    this.devices = devices;
    this.screen = screen;
  }
  handle(action: z.infer<typeof NativeServiceAction>): void {
    if (action.type === "service.cancel") {
      this.#pending.get(action.id)?.abort();
      return;
    }
    if (this.#pending.has(action.id)) return;
    void this.#request(action.id, action.request);
  }
  async #request(id: string, raw: unknown): Promise<void> {
    const controller = new AbortController();
    if (this.#pending.size >= 32) {
      this.#reply(id, false, null, "Too many requests. Try again shortly.");
      return;
    }
    this.#pending.set(id, controller);
    try {
      const screen = NativeScreenRequest.safeParse(raw);
      if (screen.success && this.screen) {
        try {
          const data = await this.screen.request(screen.data.operation, controller.signal);
          this.#reply(id, true, { ok: true, data }, "");
        } catch (error) {
          this.#reply(
            id,
            true,
            {
              ok: false,
              error: { message: error instanceof Error ? error.message : "Screen request failed" },
            },
            "",
          );
        }
        return;
      }
      const device = NativeDeviceRequest.safeParse(raw);
      if (device.success && this.devices) {
        try {
          const data = await this.devices.request(device.data.operation, controller.signal);
          this.#reply(id, true, { ok: true, data }, "");
        } catch (error) {
          this.#reply(
            id,
            true,
            {
              ok: false,
              error: { message: error instanceof Error ? error.message : "Device request failed" },
            },
            "",
          );
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
      const transcript = NativeTranscriptRequest.safeParse(raw);
      if (transcript.success) {
        this.#reply(id, true, await this.transcript.read(transcript.data, controller.signal), "");
        return;
      }
      const window = NativeHistoryWindow.safeParse(raw);
      if (window.success) {
        this.#reply(
          id,
          true,
          await readHistoryWindow(this.owner, window.data, controller.signal),
          "",
        );
        return;
      }
      const media = NativeMediaRequest.safeParse(raw);
      if (media.success) {
        this.#reply(id, true, await readNativeMedia(this.owner, media.data, controller.signal), "");
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
      this.#reply(id, true, value, "");
    } catch {
      this.#reply(
        id,
        false,
        null,
        "Couldn't complete the request. Check the machine connection and retry.",
      );
    } finally {
      this.#pending.delete(id);
    }
  }
  #reply(id: string, ok: boolean, value: unknown, message: string): void {
    this.sink.put(`service:${id}`, () => ({ type: "service.reply", id, ok, value, message }));
  }
}
