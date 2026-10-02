import { PreviewPort } from "@ace/protocol/preview";
import { decodeFrame, encodeFrame, frameSize, kinds, windowSize } from "./relay-wire.ts";

/** Exclusive ordered preview subchannel. send resolves under bounded transport admission. */
export type PreviewChannel = {
  send(frame: Uint8Array): Promise<void>;
  close(): void;
  subscribe(onFrame: (frame: Uint8Array) => void, onClose: () => void): () => void;
};
/** Native bridges expose bounded socket queues and Node-like stream events. */
export type PreviewSocket = {
  readonly readableLength: number;
  readonly writableLength: number;
  pause(): unknown;
  resume(): unknown;
  destroy(): unknown;
  end(): unknown;
  connect(port: number, host: string): unknown;
  write(bytes: Uint8Array, callback: (error?: Error | null) => void): unknown;
  on(event: "data", listener: (bytes: Uint8Array) => void): unknown;
  on(event: "end" | "close" | "error", listener: () => void): unknown;
  once(event: "connect", listener: () => void): unknown;
};
type Stream = {
  id: number;
  socket: PreviewSocket;
  ready: boolean;
  sendCredit: number;
  receiveCredit: number;
  incomingEnded: boolean;
  outgoingEnded: boolean;
  pending: Promise<void>;
  wake: (() => void) | undefined;
};
type MuxOptions = {
  channel: PreviewChannel;
  maxStreams: number;
  allowPort?: (port: number) => Promise<boolean>;
  socketFactory?: () => PreviewSocket;
  onClosed?: () => void;
};

/** Socket I/O is paused while one bounded chunk waits for remote credit. */
export function createMux(options: MuxOptions) {
  if (options.allowPort && !options.socketFactory)
    throw new Error("Host relay requires a socket factory");
  const streams = new Map<number, Stream>();
  let closed = false;
  let lastId = 0;
  let nextId = 1;
  let pendingSends = 0;
  const maxPendingSends = options.maxStreams * 34 + 32;
  let unsubscribe: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    options.channel.close();
    for (const stream of streams.values()) {
      stream.socket.destroy();
      stream.wake?.();
    }
    streams.clear();
    options.onClosed?.();
  };
  const send = async (kind: number, id: number, value = 0, data?: Uint8Array) => {
    if (closed) return;
    if (pendingSends >= maxPendingSends) {
      close();
      return;
    }
    pendingSends++;
    try {
      await options.channel.send(encodeFrame(kind, id, value, data));
    } catch {
      close();
    } finally {
      pendingSends--;
    }
  };
  const alive = (stream: Stream) => !closed && streams.get(stream.id) === stream;
  const remove = (stream: Stream) => {
    if (streams.get(stream.id) !== stream) return;
    streams.delete(stream.id);
    stream.wake?.();
    stream.socket.destroy();
  };
  const transmit = async (stream: Stream, chunk: Uint8Array) => {
    for (let offset = 0; offset < chunk.length && alive(stream);) {
      if (!stream.ready || stream.sendCredit === 0) {
        await new Promise<void>((resolve) => {
          stream.wake = resolve;
        });
        stream.wake = undefined;
        continue;
      }
      const length = Math.min(frameSize, stream.sendCredit, chunk.length - offset);
      stream.sendCredit -= length;
      await send(kinds.data, stream.id, length, chunk.subarray(offset, offset + length));
      offset += length;
    }
    if (alive(stream)) stream.socket.resume();
  };
  const bind = (id: number, socket: PreviewSocket): Stream => {
    const stream: Stream = {
      id,
      socket,
      ready: false,
      sendCredit: windowSize,
      receiveCredit: windowSize,
      incomingEnded: false,
      outgoingEnded: false,
      pending: Promise.resolve(),
      wake: undefined,
    };
    streams.set(id, stream);
    socket.pause();
    socket.on("data", (chunk: Uint8Array) => {
      socket.pause();
      stream.pending = transmit(stream, chunk).catch(close);
    });
    socket.on("end", () => {
      stream.pending = stream.pending.then(async () => {
        if (alive(stream)) {
          stream.outgoingEnded = true;
          await send(kinds.end, id);
        }
      });
    });
    socket.on("error", () => {
      void send(kinds.reset, id);
      remove(stream);
    });
    socket.on("close", () => {
      void stream.pending.then(() => {
        if (streams.get(id) === stream) {
          streams.delete(id);
          stream.wake?.();
          if (!stream.incomingEnded || !stream.outgoingEnded) void send(kinds.reset, id);
        }
      });
    });
    return stream;
  };
  const ready = (stream: Stream) => {
    stream.ready = true;
    stream.wake?.();
    stream.socket.resume();
  };
  const accept = async (id: number, port: number) => {
    // Reserve capacity before awaiting authorization. A rejected open is reset, never dialed.
    const socket = options.socketFactory?.();
    if (!socket) throw new Error("Missing host socket factory");
    if (closed) {
      socket.destroy();
      return;
    }
    const stream = bind(id, socket);
    try {
      if (!(await options.allowPort?.(port)) || !alive(stream)) {
        await send(kinds.reset, id);
        remove(stream);
        return;
      }
      socket.once("connect", () => {
        void send(kinds.ready, id).then(() => {
          if (alive(stream)) ready(stream);
        });
      });
      socket.connect(port, "127.0.0.1");
    } catch {
      await send(kinds.reset, id);
      remove(stream);
    }
  };
  const receive = (input: Uint8Array) => {
    try {
      const frame = decodeFrame(input);
      if (frame.kind === kinds.open) {
        if (!options.allowPort || frame.id <= lastId) throw new Error("Invalid stream open");
        lastId = frame.id;
        const port = PreviewPort.parse(frame.value);
        if (streams.size >= options.maxStreams) {
          void send(kinds.reset, frame.id);
          return;
        }
        void accept(frame.id, port).catch(close);
        return;
      }
      const stream = streams.get(frame.id);
      if (!stream) return; // Late frames for a locally reset stream cannot revive it.
      if (frame.kind === kinds.reset) {
        remove(stream);
        return;
      }
      if (frame.kind === kinds.ready) {
        if (options.allowPort || stream.ready) throw new Error("Duplicate stream ready");
        ready(stream);
        return;
      }
      if (!stream.ready) throw new Error("Data before ready");
      if (frame.kind === kinds.credit) {
        if (!frame.value || stream.sendCredit + frame.value > windowSize)
          throw new Error("Invalid stream credit");
        stream.sendCredit += frame.value;
        stream.wake?.();
      } else if (frame.kind === kinds.data) {
        if (stream.incomingEnded || frame.value > stream.receiveCredit)
          throw new Error("Receive window exceeded");
        stream.receiveCredit -= frame.value;
        stream.socket.write(frame.data, (error) => {
          if (error || !alive(stream)) return;
          stream.receiveCredit += frame.value;
          void send(kinds.credit, stream.id, frame.value);
        });
      } else if (frame.kind === kinds.end) {
        if (stream.incomingEnded) throw new Error("Duplicate stream end");
        stream.incomingEnded = true;
        stream.socket.end();
      }
    } catch {
      close();
    }
  };
  unsubscribe = options.channel.subscribe(receive, close);
  if (closed) unsubscribe();
  return {
    open(socket: PreviewSocket, port: number) {
      if (
        options.allowPort ||
        closed ||
        streams.size >= options.maxStreams ||
        nextId > 0xffffffff
      ) {
        socket.destroy();
        return;
      }
      const id = nextId++;
      bind(id, socket);
      void send(kinds.open, id, PreviewPort.parse(port));
    },
    close,
    // Observability reports counts and windows, never retained payloads.
    stats: () => ({
      streams: streams.size,
      bufferedBytes: [...streams.values()].reduce(
        (n, s) => n + s.socket.readableLength + s.socket.writableLength,
        0,
      ),
      closed,
    }),
  };
}
