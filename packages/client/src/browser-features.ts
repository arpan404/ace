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
  /**
   * The person's answer to a site's sign-in prompt; without credentials it is cancelled. The
   * credentials go to the page's browser for that request; nothing in ace keeps them.
   */
  answerAuth(
    threadId: string,
    tabId: string,
    authId: string,
    credentials?: { username: string; password: string },
    options?: RequestOptions,
  ) {
    return this.read(
      {
        type: "browser.auth.answer",
        threadId: ThreadId.parse(threadId),
        tabId,
        authId,
        ...(credentials ? { credentials } : {}),
      },
      BrowserState,
      options,
    );
  }
  /** The person's files (thread attachments) for the tab's open file picker; none cancels it. */
  chooseFiles(
    threadId: string,
    tabId: string,
    chooserId: string,
    files: readonly { sha256: string; name: string }[],
    options?: RequestOptions,
  ) {
    return this.read(
      {
        type: "browser.files.choose",
        threadId: ThreadId.parse(threadId),
        tabId,
        chooserId,
        files: [...files],
      },
      BrowserState,
      options,
    );
  }
  /**
   * The person's files (thread attachments) dropped on the tab's page at a point in its CSS
   * pixels: the page gets them as a native drop there.
   */
  dropFiles(
    threadId: string,
    tabId: string,
    point: { x: number; y: number; modifiers?: number },
    files: readonly { sha256: string; name: string }[],
    options?: RequestOptions,
  ) {
    return this.read(
      {
        type: "browser.files.drop",
        threadId: ThreadId.parse(threadId),
        tabId,
        x: Math.max(0, point.x),
        y: Math.max(0, point.y),
        modifiers: point.modifiers ?? 0,
        files: [...files],
      },
      BrowserState,
      options,
    );
  }
  /** Turn a tab's sound off or on; it stays that way until the person changes it. */
  muteTab(threadId: string, tabId: string, muted: boolean, options?: RequestOptions) {
    return this.read(
      { type: "browser.tabs.mute", threadId: ThreadId.parse(threadId), tabId, muted },
      BrowserState,
      options,
    );
  }
  /** Proceed past the tab's certificate error to `url`, for that origin and certificate. */
  proceedCertificate(threadId: string, tabId: string, url: string, options?: RequestOptions) {
    return this.read(
      { type: "browser.certificate.proceed", threadId: ThreadId.parse(threadId), tabId, url },
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
