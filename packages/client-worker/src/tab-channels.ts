import {
  ClientError,
  type ClientCore,
  type ServiceWire,
  type ServiceRequest,
  type ServiceResponse,
} from "@ace/client";
import { ThreadId, type ClientMessage } from "@ace/protocol";
import { BrowserSubscriptions } from "./browser-subscriptions.ts";
import { objectInput } from "./calls.ts";

/*
 * A tab's channel-scoped state: the binary file channels it opened and its Preview (browser)
 * subscriptions. The host initializes these with the client's service wire whose full
 * `ClientMessage` it decodes requests with, the first time a tab makes a `files.*` or
 * `browser.*` request. Keeping this small module in the host avoids a separate chunk's
 * overhead while service schemas still load on demand (ADR 0056).
 */

type BrowserTransition = Extract<
  ClientMessage,
  { type: "browser.subscribe" | "browser.unsubscribe" }
>;

/** One `request` of a tab, with what the host knows about the connection it started on. */
export interface ChannelCall {
  client: ClientCore;
  args: unknown[];
  signal: AbortSignal;
  /** Send the (possibly rewritten) request arguments through the worker's client. */
  forward(args: unknown[]): Promise<ServiceResponse<ServiceRequest>>;
  /** The connection the request started on is still the client's current one. */
  current(): boolean;
  /** The tab still waits for this request's reply. */
  pending(): boolean;
}

export class TabChannels {
  private subscriber: string;
  private wire: ServiceWire;
  private browsers = new BrowserSubscriptions();
  /** Open file channels, with the upload each one belongs to. */
  private files = new Map<number, string | undefined>();
  constructor(subscriber: string, wire: ServiceWire) {
    this.subscriber = subscriber;
    this.wire = wire;
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
  detach(client: ClientCore | undefined): void {
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
    const parsed = this.wire.ClientMessage.safeParse({
      ...objectInput(args[0]),
      requestId: "worker",
    });
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
    if (value.type === "files.data" && Number.isInteger(value.channel) && value.eof)
      this.files.delete(value.channel);
    if (
      (value.type === "files.ready" || value.type === "files.upload") &&
      Number.isInteger(value.channel)
    ) {
      if (!call.current()) throw new ClientError("offline");
      if (!call.pending()) client.send({ type: "files.cancel", channel: value.channel });
      else
        this.files.set(value.channel, value.type === "files.upload" ? value.uploadId : undefined);
    }
    if (value.type === "files.result" && parsed.success && parsed.data.type === "files.request") {
      const operation = parsed.data.operation;
      if (operation.op === "upload.commit" || operation.op === "upload.cancel")
        for (const [channel, uploadId] of this.files)
          if (uploadId === operation.uploadId) this.files.delete(channel);
    }
    return value;
  }
  private unsubscribe(client: ClientCore, threadId: string): void {
    void client
      .request({
        type: "browser.unsubscribe",
        threadId: ThreadId.parse(threadId),
        subscriberId: this.subscriber,
      })
      .catch(() => {});
  }
}
