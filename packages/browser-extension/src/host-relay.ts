import type { Readable, Writable } from "node:stream";
import {
  UserBrowserDaemonMessage,
  UserBrowserExtensionMessage,
  userBrowserNativeMessageLimit,
  type UserBrowserLink,
} from "@ace/protocol";
import type { WebSocket } from "ws";
import { z } from "zod";
import { encodeNativeMessage, NativeMessageDecoder } from "./framing.ts";

/** The daemon socket refuses messages over 1 MiB; keep a margin for the envelope. */
export const daemonMessageLimit = 1024 * 1024 - 1024;
/** Chrome accepts up to 64 MiB from the extension; anything near that is a broken peer. */
const extensionMessageLimit = 64 * 1024 * 1024;
const pingMs = 20_000;
const noop = () => {};
const Envelope = z.object({ type: z.string() });

export interface HostCredential {
  deviceId: string;
  token: string;
}
export interface HostRelayOptions {
  /** Chrome's end of the port: frames from the extension. */
  input: Readable;
  /** Frames to the extension. */
  output: Writable;
  /** The daemon's loopback origin, read fresh for every connection attempt. */
  endpoint(): Promise<string>;
  credential(): Promise<HostCredential>;
  open(url: string): WebSocket;
  delay(milliseconds: number, work: () => void): () => void;
  log(message: string): void;
}

/**
 * The native host's whole job (ADR 0084): relay `user_browser.*` messages between the extension
 * and the daemon, validating both directions, and keep the daemon link up with capped backoff.
 * Resolves when the extension closes the port.
 */
export function relayNativeHost(options: HostRelayOptions): Promise<void> {
  const decoder = new NativeMessageDecoder(extensionMessageLimit);
  let socket: WebSocket | undefined;
  let welcomed = false;
  let stopped = false;
  let attempt = 0;
  let cancelRetry = noop;
  let cancelPing = noop;
  const { promise: done, resolve } = Promise.withResolvers<void>();

  const toExtension = (message: unknown) => {
    try {
      options.output.write(encodeNativeMessage(message, userBrowserNativeMessageLimit));
    } catch (error) {
      options.log(`Dropped a message to the extension: ${String(error)}`);
    }
  };
  const link = (state: UserBrowserLink["state"], detail?: string) =>
    toExtension({ type: "user_browser.link", state, ...(detail ? { detail } : {}) });
  const ping = () => {
    cancelPing = options.delay(pingMs, () => {
      if (welcomed && socket?.readyState === 1) socket.send(JSON.stringify({ type: "ping" }));
      ping();
    });
  };

  const toDaemon = (raw: unknown) => {
    const parsed = UserBrowserExtensionMessage.safeParse(raw);
    if (!parsed.success || !welcomed || !socket || socket.readyState !== 1) return;
    let text = JSON.stringify(parsed.data);
    if (Buffer.byteLength(text) > daemonMessageLimit) {
      // A reply must still settle its command; an event is simply dropped.
      if (parsed.data.type !== "user_browser.reply") return;
      text = JSON.stringify({
        type: "user_browser.reply",
        id: parsed.data.id,
        ok: false,
        error: "The result is larger than ace's browser relay allows",
      });
    }
    socket.send(text);
  };

  const retry = (state: UserBrowserLink["state"], detail?: string) => {
    if (stopped) return;
    link(state, detail);
    const wait = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5));
    cancelRetry = options.delay(state === "unauthorized" ? 30_000 : wait, () => void connect());
  };

  async function connect(): Promise<void> {
    if (stopped) return;
    link("connecting");
    let origin: string;
    let credential: HostCredential;
    try {
      [origin, credential] = await Promise.all([options.endpoint(), options.credential()]);
    } catch {
      retry("unavailable", "ace isn't running, or Use my Chrome isn't installed");
      return;
    }
    if (stopped) return;
    const url = new URL(origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/";
    const current = options.open(url.href);
    socket = current;
    let refused = false;
    current.on("open", () =>
      current.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          deviceId: credential.deviceId,
          token: credential.token,
        }),
      ),
    );
    current.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!welcomed) {
        const type = Envelope.safeParse(message).data?.type;
        if (type === "welcome") {
          welcomed = true;
          attempt = 0;
          link("connected");
          ping();
        } else if (type === "error") refused = true;
        return;
      }
      const parsed = UserBrowserDaemonMessage.safeParse(message);
      if (parsed.success) toExtension(parsed.data);
    });
    current.on("error", () => {});
    current.on("close", (code) => {
      if (socket !== current) return;
      socket = undefined;
      welcomed = false;
      cancelPing();
      if (refused || code === 4001 || code === 4003) retry("unauthorized");
      else retry("unavailable", "ace isn't running");
    });
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelRetry();
    cancelPing();
    socket?.close(1000, "Browser closed the extension port");
    socket = undefined;
    resolve();
  };
  options.input.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      options.log(String(error));
      stop();
      return;
    }
    for (const message of messages) toDaemon(message);
  });
  options.input.on("end", stop);
  options.input.on("close", stop);
  options.input.on("error", stop);
  void connect();
  return done;
}
