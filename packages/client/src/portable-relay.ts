import { ClientMessage, ServerMessage } from "@ace/protocol";
import {
  CREDIT_FLAG,
  FlowCredit,
  MAX_MESSAGE,
  NoiseXX,
  fragmentCost,
  readCredit,
  type HandshakeOptions,
  type Transport,
} from "@ace/secure-channel";
import { inflate } from "./inflate.ts";
import { RelayClosedError } from "./relay-closed.ts";
import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";

/** Browser and React Native socket boundary; no Node or ws dependency. */
export interface PortableSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  /** Sockets that know the close code pass it (a browser's CloseEvent does). */
  addEventListener(
    type: "close",
    listener: (event?: { code?: number; reason?: string }) => void,
  ): void;
  send(data: string | Uint8Array): void;
  close(): void;
}
export interface PortableRelay {
  send(message: ClientMessage): Promise<void>;
  receive(): Promise<ServerMessage | Uint8Array>;
  /**
   * Send JSON text already encoded from a valid client message (the main connection encodes its
   * own), up to `limit` bytes; 256 KiB unless given.
   */
  sendText(text: string, limit?: number): Promise<void>;
  /** The next message as JSON text (inflated, UTF-8 checked, not schema-parsed) or bytes. */
  receiveRaw(): Promise<string | Uint8Array>;
  close(): void;
}
export interface PortableRelayOptions {
  relayUrl: string;
  pinnedFingerprint: string;
  /** Opens the socket, offering `protocols` as WebSocket subprotocols when given. */
  socket(url: string, protocols?: string[]): PortableSocket;
  /** A device grant for ace's hosted relay (ADR 0111), offered as `ace.grant.<token>`. */
  grant?: string | undefined;
  keys(): Pick<HandshakeOptions, "staticKey" | "ephemeralKey">;
  schedule(callback: () => void, delayMs: number): () => void;
  signal?: AbortSignal;
}
const prologue = new TextEncoder().encode("ace daemon relay stream v1");

const queueLimit = 1024 * 1024;
const logicalLimit = 16 * 1024 * 1024;
const rekeyInterval = 1 << 20;

/**
 * Uses the relay's Noise XX and fragmentation contract with injected platform I/O. After the
 * handshake each frame is decrypted as it arrives. When the daemon sends a credit fragment
 * (only to a hello that asked, `flowControl: ["credit"]`), both directions are flow controlled:
 * this end returns credit as it reads, and sends no more than the daemon has room for.
 */
export async function connectPortableRelay(options: PortableRelayOptions): Promise<PortableRelay> {
  if (!/^[A-Z2-7]{52}$/.test(options.pinnedFingerprint))
    throw new Error("Invalid host fingerprint");
  const url = new URL(options.relayUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("Expected relay WebSocket URL");
  url.pathname = "/client";
  url.search = new URLSearchParams({ hostId: options.pinnedFingerprint }).toString();
  url.hash = "";
  const socket = options.grant
    ? options.socket(url.toString(), [`${GRANT_SUBPROTOCOL_PREFIX}${options.grant}`])
    : options.socket(url.toString());
  socket.binaryType = "arraybuffer";
  const queue: (Uint8Array | undefined)[] = Array.from({ length: 256 });
  let head = 0;
  let count = 0;
  let bytes = 0;
  let error: Error | undefined;
  let crypto: Transport | undefined;
  let pending: { resolve(data: Uint8Array): void; reject(error: Error): void } | undefined;
  let opened: { resolve(): void; reject(error: Error): void } | undefined;
  const flow = new FlowCredit();
  const creditWaiters: (() => void)[] = [];
  let sendCount = 0;
  let receiveCount = 0;
  const close = (failure = new Error("Relay channel closed")) => {
    if (error) return;
    error = failure;
    crypto?.destroy();
    for (const wake of creditWaiters.splice(0)) wake();
    queue.fill(undefined);
    head = 0;
    count = 0;
    bytes = 0;
    pending?.reject(failure);
    pending = undefined;
    opened?.reject(failure);
    opened = undefined;
    socket.close();
  };
  socket.addEventListener("open", () => opened?.resolve());
  socket.addEventListener("close", (event) =>
    close(
      event?.code === undefined ? undefined : new RelayClosedError(event.code, event.reason ?? ""),
    ),
  );
  socket.addEventListener("error", () => close(new Error("Relay socket failed")));
  /** Queue a frame (a handshake message, or a decrypted data fragment) for the reader. */
  const enqueue = (frame: Uint8Array) => {
    if (count >= 256 || bytes + frame.length > queueLimit)
      throw new Error("Relay frame queue limit or invalid binary frame");
    if (pending) {
      const waiter = pending;
      pending = undefined;
      waiter.resolve(frame);
    } else {
      queue[(head + count) % 256] = frame;
      count++;
      bytes += frame.length;
    }
  };
  /** Encrypt the next outgoing fragment; rekeys right after the frame that reaches the interval. */
  const seal = (secured: Transport, plain: Uint8Array): Uint8Array => {
    const frame = secured.send.encrypt(plain);
    if (++sendCount % rekeyInterval === 0) secured.send.rekey();
    return frame;
  };
  /** A credit goes out at once, ahead of data still waiting for the daemon's credit. */
  const sendCredit = (plain: Uint8Array | undefined) => {
    if (plain && crypto && !error) write(seal(crypto, plain));
  };
  /** A frame after the handshake: a credit is applied now, data waits for the reader. */
  const accept = (secured: Transport, frame: Uint8Array) => {
    const plain = secured.receive.decrypt(frame);
    if (++receiveCount % rekeyInterval === 0) secured.receive.rekey();
    if (plain[0] === CREDIT_FLAG) {
      sendCredit(flow.credited(readCredit(plain)));
      for (const wake of creditWaiters.splice(0)) wake();
      return;
    }
    if (!flow.received(fragmentCost(plain.length)))
      throw new Error("The daemon overran its flow window");
    enqueue(plain);
  };
  socket.addEventListener("message", ({ data }) => {
    if (error) return;
    const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    try {
      if (!(frame instanceof Uint8Array) || frame.length > MAX_MESSAGE)
        throw new Error("Relay frame queue limit or invalid binary frame");
      if (crypto) accept(crypto, frame);
      else enqueue(frame);
    } catch (failure) {
      close(failure instanceof Error ? failure : new Error("Invalid relay frame"));
    }
  });
  const next = (): Promise<Uint8Array> => {
    if (error) return Promise.reject(error);
    const frame = count ? queue[head] : undefined;
    if (frame) {
      queue[head] = undefined;
      head = (head + 1) % 256;
      count--;
      bytes -= frame.length;
      return Promise.resolve(frame);
    }
    if (pending) return Promise.reject(new Error("Concurrent relay read"));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  };
  const write = (frame: Uint8Array) => {
    if (error) throw error;
    if (socket.bufferedAmount + frame.length > queueLimit)
      throw new Error("Relay send queue limit");
    socket.send(frame);
  };
  const aborted = () => close(new Error("Relay connection cancelled"));
  options.signal?.addEventListener("abort", aborted, { once: true });
  const cancel = options.schedule(() => close(new Error("Relay handshake timed out")), 10000);
  const state = new NoiseXX({
    initiator: true,
    ...options.keys(),
    prologue,
    pinnedFingerprint: options.pinnedFingerprint,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      opened = { resolve, reject };
      if (options.signal?.aborted) aborted();
    });
    opened = undefined;
    const marker = await next();
    if (marker.length !== 1 || marker[0] !== 1) throw new Error("Invalid relay pairing marker");
    write(state.writeMessage());
    if (state.readMessage(await next()).length) throw new Error("Unexpected handshake payload");
    write(state.writeMessage());
    const secured = state.transport;
    // Frames that came in with the last handshake message are still ciphertext.
    const early: Uint8Array[] = [];
    for (; count > 0; count--) {
      const frame = queue[head];
      queue[head] = undefined;
      head = (head + 1) % 256;
      if (frame) early.push(frame);
    }
    bytes = 0;
    crypto = secured;
    for (const frame of early) accept(secured, frame);
  } catch (failure) {
    state.destroy();
    close(failure instanceof Error ? failure : new Error("Relay handshake failed"));
    throw failure;
  } finally {
    cancel();
  }
  const secured = crypto;
  let sending = Promise.resolve();
  let queuedBytes = 0;
  let receiving = false;
  return {
    close() {
      options.signal?.removeEventListener("abort", aborted);
      close();
    },
    send(message) {
      return sendBody(new TextEncoder().encode(JSON.stringify(ClientMessage.parse(message))));
    },
    sendText(text, limit) {
      return sendBody(new TextEncoder().encode(text), limit);
    },
    async receive() {
      const payload = await receivePayload();
      if (payload instanceof Uint8Array) return payload;
      try {
        return ServerMessage.parse(JSON.parse(payload));
      } catch (failure) {
        close(failure instanceof Error ? failure : new Error("Invalid relay message"));
        throw failure;
      }
    },
    receiveRaw: () => receivePayload(),
  };
  function sendBody(body: Uint8Array, limit = 256 * 1024): Promise<void> {
    if (body.length > limit || queuedBytes + body.length > queueLimit) {
      body.fill(0);
      return Promise.reject(new Error("Relay request queue limit"));
    }
    queuedBytes += body.length;
    const task = sending
      .then(async () => {
        const size = MAX_MESSAGE - 17;
        for (let offset = 0; offset < body.length; offset += size) {
          const chunk = body.subarray(offset, offset + size);
          const cost = fragmentCost(chunk.length + 1);
          const waiting = () => !error && !flow.allows(cost);
          while (waiting()) await new Promise<void>((resolve) => creditWaiters.push(resolve));
          if (error) throw error;
          flow.spend(cost);
          const plain = new Uint8Array(chunk.length + 1);
          plain[0] = offset + chunk.length === body.length ? 1 : 0;
          plain.set(chunk, 1);
          try {
            write(seal(secured, plain));
          } finally {
            plain.fill(0);
          }
        }
      })
      .catch((failure: unknown) => {
        close(failure instanceof Error ? failure : new Error("Relay send failed"));
        throw failure;
      })
      .finally(() => {
        queuedBytes -= body.length;
        body.fill(0);
      });
    sending = task.catch(() => {});
    return task;
  }
  /** One whole message: bytes, or its JSON text. */
  async function receivePayload(): Promise<string | Uint8Array> {
    if (receiving) throw new Error("Concurrent relay read");
    receiving = true;
    try {
      const chunks: Uint8Array[] = [];
      let length = 0;
      // 0: JSON, 2: binary, 4: deflated JSON (only after this client's hello asked for it).
      let kind: number | undefined;
      while (true) {
        const plain = await next();
        sendCredit(flow.consumed(fragmentCost(plain.length)));
        const flag = plain[0];
        if (
          plain.length < 2 ||
          flag === undefined ||
          flag > 5 ||
          (flag % 2 === 0 && plain.length !== MAX_MESSAGE - 16)
        )
          throw new Error("Invalid relay fragment");
        const fragmentKind = flag - (flag % 2);
        if (kind !== undefined && kind !== fragmentKind)
          throw new Error("Mixed relay fragment kinds");
        kind = fragmentKind;
        length += plain.length - 1;
        if (length > (kind === 2 ? 64 * 1024 + 16 : logicalLimit))
          throw new Error("Relay message limit");
        chunks.push(plain.subarray(1));
        if (flag % 2) break;
      }
      const payload = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        payload.set(chunk, offset);
        offset += chunk.length;
      }
      if (kind === 2) return payload;
      const json = kind === 4 ? await inflate("deflate-raw", payload, logicalLimit) : payload;
      return new TextDecoder("utf-8", { fatal: true }).decode(json);
    } catch (failure) {
      close(failure instanceof Error ? failure : new Error("Invalid relay message"));
      throw failure;
    } finally {
      receiving = false;
    }
  }
}
