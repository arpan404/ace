import type { ClientCore } from "@ace/client";
import {
  AutomationRequest,
  BrowserClientMessage,
  CatalogList,
  CommandsList,
  CommandsResolve,
  McpProviderRequest,
  PromptFilesRequest,
  ProviderLoginRequest,
  ScreenClientMessage,
  SettingsRequest,
  StorageRequest,
  TerminalRequest,
  UsageSummary,
} from "@ace/protocol";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { NativeMediaRequest, readNativeMedia } from "./native-media.ts";

// The SDK validates every request and reply. The native bridge exposes only these services;
// mutations of threads continue to go through the SDK's durable command outbox.
const Request = z.union([
  AutomationRequest,
  BrowserClientMessage,
  CatalogList,
  CommandsList,
  CommandsResolve,
  McpProviderRequest,
  PromptFilesRequest,
  ProviderLoginRequest,
  ScreenClientMessage,
  SettingsRequest,
  StorageRequest,
  TerminalRequest,
  UsageSummary,
]);
export const NativeServiceAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("service"), id: z.string().min(1).max(128), request: z.unknown() }),
  z.object({ type: z.literal("service.cancel"), id: z.string().min(1).max(128) }),
]);

export class NativeServices {
  #pending = new Map<string, AbortController>();
  readonly owner: ClientCore;
  readonly sink: PatchSink;
  constructor(owner: ClientCore, sink: PatchSink) {
    this.owner = owner;
    this.sink = sink;
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
