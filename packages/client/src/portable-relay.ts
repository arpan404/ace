import { ClientMessage, ServerMessage } from "@ace/protocol";
import { MAX_MESSAGE, NoiseXX, type HandshakeOptions, type Transport } from "@ace/secure-channel";

/** Browser and React Native socket boundary; no Node or ws dependency. */
export interface PortableSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  send(data: string | Uint8Array): void;
  close(): void;
}
export interface PortableRelay {
  send(message: ClientMessage): Promise<void>;
  receive(): Promise<ServerMessage | Uint8Array>;
  close(): void;
}
export interface PortableRelayOptions {
  relayUrl: string;
  pinnedFingerprint: string;
  socket(url: string): PortableSocket;
  keys(): Pick<HandshakeOptions, "staticKey" | "ephemeralKey">;
  schedule(callback: () => void, delayMs: number): () => void;
  signal?: AbortSignal;
}
const prologue = new TextEncoder().encode("ace daemon relay stream v1");
const queueLimit = 1024 * 1024;
const logicalLimit = 16 * 1024 * 1024;
const rekeyInterval = 1 << 20;

/** Uses the relay's Noise XX and fragmentation contract with injected platform I/O. */
export async function connectPortableRelay(options: PortableRelayOptions): Promise<PortableRelay> {
  if (!/^[A-Z2-7]{52}$/.test(options.pinnedFingerprint))
    throw new Error("Invalid host fingerprint");
  const url = new URL(options.relayUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("Expected relay WebSocket URL");
  url.pathname = "/client";
  url.search = new URLSearchParams({ hostId: options.pinnedFingerprint }).toString();
  url.hash = "";
  const socket = options.socket(url.toString());
  socket.binaryType = "arraybuffer";
  const queue: (Uint8Array | undefined)[] = Array.from({ length: 256 });
  let head = 0;
  let count = 0;
  let bytes = 0;
  let error: Error | undefined;
  let crypto: Transport | undefined;
  let pending: { resolve(data: Uint8Array): void; reject(error: Error): void } | undefined;
  let opened: { resolve(): void; reject(error: Error): void } | undefined;
  const close = (failure = new Error("Relay channel closed")) => {
    if (error) return;
    error = failure;
    crypto?.destroy();
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
  socket.addEventListener("close", () => close());
  socket.addEventListener("error", () => close(new Error("Relay socket failed")));
  socket.addEventListener("message", ({ data }) => {
    if (error) return;
    const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (
      !(frame instanceof Uint8Array) ||
      frame.length > MAX_MESSAGE ||
      count >= 256 ||
      bytes + frame.length > queueLimit
    ) {
      close(new Error("Relay frame queue limit or invalid binary frame"));
      return;
    }
    if (pending) {
      const waiter = pending;
      pending = undefined;
      waiter.resolve(frame);
    } else {
      queue[(head + count) % 256] = frame;
      count++;
      bytes += frame.length;
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
    crypto = state.transport;
  } catch (failure) {
    state.destroy();
    close(failure instanceof Error ? failure : new Error("Relay handshake failed"));
    throw failure;
  } finally {
    cancel();
  }
  const secured = crypto;
  let sending = Promise.resolve();
  let sendCount = 0;
  let receiveCount = 0;
  let queuedBytes = 0;
  let receiving = false;
  return {
    close() {
      options.signal?.removeEventListener("abort", aborted);
      close();
    },
    send(message) {
      const body = new TextEncoder().encode(JSON.stringify(ClientMessage.parse(message)));
      if (body.length > 256 * 1024 || queuedBytes + body.length > queueLimit) {
        body.fill(0);
        return Promise.reject(new Error("Relay request queue limit"));
      }
      queuedBytes += body.length;
      const task = sending
        .then(() => {
          const size = MAX_MESSAGE - 17;
          for (let offset = 0; offset < body.length; offset += size) {
            const chunk = body.subarray(offset, offset + size);
            const plain = new Uint8Array(chunk.length + 1);
            plain[0] = offset + chunk.length === body.length ? 1 : 0;
            plain.set(chunk, 1);
            try {
              write(secured.send.encrypt(plain));
            } finally {
              plain.fill(0);
            }
            if (++sendCount % rekeyInterval === 0) secured.send.rekey();
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
    },
    async receive() {
      if (receiving) throw new Error("Concurrent relay read");
      receiving = true;
      try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        let binary: boolean | undefined;
        while (true) {
          const plain = secured.receive.decrypt(await next());
          if (++receiveCount % rekeyInterval === 0) secured.receive.rekey();
          const flag = plain[0];
          if (
            plain.length < 2 ||
            flag === undefined ||
            flag > 3 ||
            (flag % 2 === 0 && plain.length !== MAX_MESSAGE - 16)
          )
            throw new Error("Invalid relay fragment");
          const kind = flag >= 2;
          if (binary !== undefined && binary !== kind)
            throw new Error("Mixed relay fragment kinds");
          binary = kind;
          length += plain.length - 1;
          if (length > (kind ? 64 * 1024 + 16 : logicalLimit))
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
        if (binary) return payload;
        return ServerMessage.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)),
        );
      } catch (failure) {
        close(failure instanceof Error ? failure : new Error("Invalid relay message"));
        throw failure;
      } finally {
        receiving = false;
      }
    },
  };
}
