import { ClientError, type Client } from "@ace/client";
import { ClientMessage, ThreadId } from "@ace/protocol";
import { z } from "zod";
import { BrowserSubscriptions } from "./browser-subscriptions.ts";
import { objectInput } from "./calls.ts";

/*
 * A tab's channel-scoped state: the binary file channels it opened and its Preview (browser)
 * subscriptions. The host loads this module the first time a tab makes a `files.*` or
 * `browser.*` request, so the worker starts without it (ADR 0056).
 */

const ChannelReply = z.object({
  type: z.string(),
  channel: z.number().int(),
  eof: z.boolean().optional(),
  uploadId: z.string().optional(),
});
const FilesResult = z.object({ type: z.literal("files.result") });
const UploadEnd = z.object({
  type: z.literal("files.request"),
  operation: z.object({ op: z.enum(["upload.commit", "upload.cancel"]), uploadId: z.string() }),
});

type BrowserTransition = Extract<
  ClientMessage,
  { type: "browser.subscribe" | "browser.unsubscribe" }
>;

/** One `request` of a tab, with what the host knows about the connection it started on. */
export interface ChannelCall {
  client: Client;
  args: unknown[];
  signal: AbortSignal;
  /** Send the (possibly rewritten) request arguments through the worker's client. */
  forward(args: unknown[]): Promise<unknown>;
  /** The connection the request started on is still the client's current one. */
  current(): boolean;
  /** The tab still waits for this request's reply. */
  pending(): boolean;
}

export class TabChannels {
  private subscriber: string;
  private browsers = new BrowserSubscriptions();
  /** Open file channels, with the upload each one belongs to. */
  private files = new Map<number, string | undefined>();
  constructor(subscriber: string) {
    this.subscriber = subscriber;
  }
  /**
   * Whether a tab's one-way file or Preview control may reach the daemon. Lifetimes open and
   * close only through tracked requests; channel controls pass only for a channel this tab
   * opened, and a cancel ends the channel here too.
   */
  admits(control: ClientMessage): boolean {
    switch (control.type) {
      case "files.pull":
      case "files.chunk":
      case "files.credit":
        return this.files.has(control.channel);
      case "files.cancel":
        return this.files.delete(control.channel);
      default:
        return false;
    }
  }
  /** The connection left `ready`: every channel and subscription ended with it. */
  reset(): void {
    this.files.clear();
    this.browsers.close(() => {});
    this.browsers = new BrowserSubscriptions();
  }
  /** The tab is leaving: release its subscriptions and cancel its open channels. */
  detach(client: Client | undefined): void {
    this.browsers.close((threadId) => {
      if (client?.state === "ready") this.unsubscribe(client, threadId);
    });
    this.browsers = new BrowserSubscriptions();
    for (const channel of this.files.keys()) {
      try {
        client?.send({ type: "files.cancel", channel });
      } catch {
        /* Socket owns cleanup when offline. */
      }
    }
    this.files.clear();
  }
  /** Run a `files.*` or `browser.*` request, tracking the channel or subscription it opens. */
  async request(call: ChannelCall): Promise<unknown> {
    const { client, args } = call;
    const assertCurrent = () => {
      if (!call.current() || client.state !== "ready") throw new ClientError("offline");
      call.signal.throwIfAborted();
    };
    const parsed = ClientMessage.safeParse({ ...objectInput(args[0]), requestId: "worker" });
    let browser: BrowserTransition | undefined;
    let forwarded = args;
    if (
      parsed.success &&
      (parsed.data.type === "browser.subscribe" || parsed.data.type === "browser.unsubscribe")
    ) {
      browser = parsed.data;
      forwarded = [{ ...parsed.data, subscriberId: this.subscriber }, ...args.slice(1)];
    }
    if (
      parsed.success &&
      (parsed.data.type === "files.pull" || parsed.data.type === "files.chunk")
    ) {
      assertCurrent();
      if (!this.files.has(parsed.data.channel))
        throw new ClientError("offline", "File channel lifetime ended");
    }
    const value = browser
      ? await this.browsers.run(
          browser.threadId,
          browser.type,
          () => {
            assertCurrent();
            return call.forward(forwarded);
          },
          () => {
            if (browser && call.current() && client.state === "ready")
              this.unsubscribe(client, browser.threadId);
          },
        )
      : await call.forward(forwarded);
    if (
      parsed.success &&
      parsed.data.type.startsWith("files.") &&
      (!call.current() || client.state !== "ready")
    )
      throw new ClientError("offline");
    const reply = ChannelReply.safeParse(value);
    if (reply.success && reply.data.type === "files.data" && reply.data.eof)
      this.files.delete(reply.data.channel);
    if (
      reply.success &&
      (reply.data.type === "files.ready" || reply.data.type === "files.upload")
    ) {
      if (!call.current()) throw new ClientError("offline");
      if (!call.pending()) client.send({ type: "files.cancel", channel: reply.data.channel });
      else this.files.set(reply.data.channel, reply.data.uploadId);
    }
    if (FilesResult.safeParse(value).success) {
      const ended = UploadEnd.safeParse(args[0]);
      if (ended.success)
        for (const [channel, uploadId] of this.files)
          if (uploadId === ended.data.operation.uploadId) this.files.delete(channel);
    }
    return value;
  }
  private unsubscribe(client: Client, threadId: string): void {
    void client
      .request({
        type: "browser.unsubscribe",
        threadId: ThreadId.parse(threadId),
        subscriberId: this.subscriber,
      })
      .catch(() => {});
  }
}
