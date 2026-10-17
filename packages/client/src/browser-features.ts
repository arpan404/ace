import { z } from "zod";
import {
  BrowserTabList,
  BrowserTabsResult,
  BrowserDownload,
  BrowserState,
  ThreadId,
} from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import type { ServiceRequest } from "./service-requests.ts";
import { ClientError, type RequestOptions } from "./types.ts";

type BrowserRequest = Extract<ServiceRequest, { type: `browser.${string}` }>;
/** Browser operations are one-shot requests and are never replayed after reconnect. */
export class BrowserFeaturesClient {
  private client: Pick<ClientApi, "request">;
  constructor(client: Pick<ClientApi, "request">) {
    this.client = client;
  }
  tabs(threadId: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.tabs.list", threadId: ThreadId.parse(threadId) },
      BrowserTabList,
      options,
    );
  }
  openTab(threadId: string, url?: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.tabs.open", threadId: ThreadId.parse(threadId), ...(url ? { url } : {}) },
      BrowserTabsResult,
      options,
    );
  }
  /** Show this tab to the person; agent tabs leave the view alone while they use it. */
  selectTab(threadId: string, tabId: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.tabs.select", threadId: ThreadId.parse(threadId), tabId },
      BrowserTabsResult,
      options,
    );
  }
  /** Closing the last tab closes the browser (`closed`). */
  closeTab(threadId: string, tabId: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.tabs.close", threadId: ThreadId.parse(threadId), tabId },
      z.union([BrowserTabsResult, z.object({ closed: z.literal(true) })]),
      options,
    );
  }
  /** "Keep agents out of this tab", or let them back in. */
  keepPrivate(threadId: string, tabId: string, value: boolean, options?: RequestOptions) {
    return this.read(
      {
        type: "browser.tabs.private",
        threadId: ThreadId.parse(threadId),
        tabId,
        private: value,
      },
      BrowserState,
      options,
    );
  }
  downloads(threadId: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.downloads.list", threadId: ThreadId.parse(threadId) },
      BrowserDownload.array().max(128),
      options,
    );
  }
  answerDialog(
    threadId: string,
    tabId: string,
    dialogId: string,
    accept: boolean,
    promptText?: string,
    options?: RequestOptions,
  ) {
    return this.read(
      {
        type: "browser.dialog.answer",
        threadId: ThreadId.parse(threadId),
        tabId,
        dialogId,
        accept,
        ...(promptText !== undefined ? { promptText } : {}),
      },
      z.object({ ok: z.literal(true) }),
      options,
    );
  }
  private async read<T>(
    request: BrowserRequest,
    schema: z.ZodType<T>,
    options?: RequestOptions,
  ): Promise<T> {
    const response = await this.client.request(request, options);
    if (!response.ok) throw new ClientError("daemon", response.error);
    const result = schema.safeParse(response.result);
    if (!result.success) throw new ClientError("protocol", "Invalid browser response");
    return result.data;
  }
}
