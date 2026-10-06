import { z } from "zod";
import {
  BrowserTab,
  BrowserTabsResult,
  BrowserDownload,
  BrowserEvaluateGrant,
  BrowserOrigin,
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
      BrowserTab.array().max(8),
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
  switchTab(threadId: string, tabId: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.tabs.switch", threadId: ThreadId.parse(threadId), tabId },
      BrowserTabsResult,
      options,
    );
  }
  closeTab(threadId: string, tabId: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.tabs.close", threadId: ThreadId.parse(threadId), tabId },
      BrowserTabsResult,
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
  evaluateGrants(threadId: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.evaluate.grants.list", threadId: ThreadId.parse(threadId) },
      BrowserEvaluateGrant.array().max(256),
      options,
    );
  }
  revokeEvaluateGrant(threadId: string, origin: string, options?: RequestOptions) {
    return this.read(
      {
        type: "browser.evaluate.grants.revoke",
        threadId: ThreadId.parse(threadId),
        origin: BrowserOrigin.parse(origin),
      },
      BrowserEvaluateGrant.array().max(256),
      options,
    );
  }
  takeover(threadId: string, mode: "shared" | "private", options?: RequestOptions) {
    return this.read(
      { type: "browser.takeover", threadId: ThreadId.parse(threadId), mode },
      BrowserState,
      options,
    );
  }
  handback(threadId: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.handback", threadId: ThreadId.parse(threadId) },
      BrowserState,
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
