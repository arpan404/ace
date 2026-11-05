import { PreviewPort } from "@ace/protocol/preview";
import { z } from "zod";
import { decodeFrame, encodeFrame, frameSize, kinds, windowSize } from "./relay-wire.ts";

const SocketChunk = z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= windowSize);

/** Exclusive ordered preview subchannel. send resolves under bounded transport admission. */
export type PreviewChannel = {
  send(frame: Uint8Array): Promise<void>;
  close(): void;
  subscribe(onFrame: (frame: Uint8Array) => void, onClose: () => void): () => void;
  readonly bufferedBytes?: number;
  readonly bufferedReceiveBytes?: number;
};
/**
 * Native bridges expose bounded socket queues and Node-like stream events. A close that follows
 * an end is graceful: the mux still sends every byte it holds and the END before it drops the
 * stream, however soon after the end the close comes. A close without an end, or an error, is
 * abortive and resets the stream at once.
 */
export type PreviewSocket = {
  readonly readableLength: number;
  readonly writableLength: number;
  pause(): unknown;
  resume(): unknown;
  destroy(): unknown;
  end(): unknown;
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
  cancelSend: (() => void) | undefined;
  payloadBytes: number;
  /** Set while a closed stream drains; restarts its deadline whenever a frame is admitted. */
  progress: (() => void) | undefined;
  cancelDeadline: (() => void) | undefined;
};
/** Runs `run` after `ms` unless the returned cancel is called first. */
export type MuxTimer = (run: () => void, ms: number) => () => void;
export const systemTimer: MuxTimer = (run, ms) => {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
};
/**
 * How long a gracefully closed stream may go without the peer admitting a frame before it is
 * reset. It matches the relay's other wait-for-the-peer bounds (bridge authentication and
 * request headers, 15 s). It restarts on progress, so a slow drain that is moving finishes, and
 * the total stays bounded: after the close at most one socket read is left to send.
 */
export const gracefulDrainMs = 15_000;
type MuxOptions = {
  channel: PreviewChannel;
  maxStreams: number;
  allowPort?: (port: number) => Promise<boolean>;
  socketFactory?: (port: number) => { socket: PreviewSocket; connect: () => void };
  onClosed?: () => void;
  timer: MuxTimer;
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
  let pendingFrameBytes = 0;
  let pendingPayloadBytes = 0;
  const maxPendingSends = options.maxStreams * 34 + 32;
  let unsubscribe: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    options.channel.close();
    for (const stream of streams.values()) {
      stream.cancelDeadline?.();
      stream.socket.destroy();
      stream.wake?.();
      stream.cancelSend?.();
    }
    streams.clear();
    options.onClosed?.();
  };
  const sendFrame = async (frame: Uint8Array) => {
    pendingSends++;
    pendingFrameBytes += frame.byteLength;
    try {
      await options.channel.send(frame);
    } catch {
      close();
    } finally {
      pendingSends--;
      pendingFrameBytes -= frame.byteLength;
    }
  };
  // Encode before entering an async writer, so a blocked writer retains only
  // its admitted frame rather than the backing buffer of a socket chunk.
  const send = (kind: number, id: number, value = 0, data?: Uint8Array): Promise<void> => {
    if (closed) return Promise.resolve();
    if (pendingSends >= maxPendingSends) {
      close();
      return Promise.resolve();
    }
    return sendFrame(encodeFrame(kind, id, value, data));
  };
  const alive = (stream: Stream) => !closed && streams.get(stream.id) === stream;
  const releasePayload = (stream: Stream) => {
    pendingPayloadBytes -= stream.payloadBytes;
    stream.payloadBytes = 0;
  };
  const remove = (stream: Stream) => {
    if (streams.get(stream.id) !== stream) return;
    streams.delete(stream.id);
    stream.cancelDeadline?.();
    stream.wake?.();
    stream.cancelSend?.();
    stream.socket.destroy();
  };
  const transmit = async (stream: Stream, chunk: Uint8Array) => {
    stream.payloadBytes = chunk.byteLength;
    pendingPayloadBytes += chunk.byteLength;
    try {
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
        const writing = send(
          kinds.data,
          stream.id,
          length,
          chunk.subarray(offset, offset + length),
        );
        // Cancelling a local socket must also release its chunk when the channel
        // writer is blocked. Admitted frames remain ordered in the channel queue.
        await new Promise<void>((resolve) => {
          if (!alive(stream)) return resolve();
          stream.cancelSend = resolve;
          void writing.then(() => {
            stream.cancelSend = undefined;
            resolve();
          });
        });
        offset += length;
        stream.progress?.();
      }
    } finally {
      releasePayload(stream);
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
      cancelSend: undefined,
      payloadBytes: 0,
      progress: undefined,
      cancelDeadline: undefined,
    };
    streams.set(id, stream);
    socket.pause();
    socket.on("data", (chunk: Uint8Array) => {
      if (!alive(stream)) return;
      if (stream.payloadBytes || !SocketChunk.safeParse(chunk).success) {
        remove(stream);
        void send(kinds.reset, id);
        return;
      }
      socket.pause();
      stream.pending = transmit(stream, chunk).catch(close);
    });
    let socketEnded = false;
    socket.on("end", () => {
      socketEnded = true;
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
    const finish = () => {
      if (!alive(stream)) return;
      remove(stream);
      if (!stream.incomingEnded || !stream.outgoingEnded) void send(kinds.reset, id);
    };
    const expire = () => {
      if (!alive(stream)) return;
      void send(kinds.reset, id);
      remove(stream);
    };
    socket.on("close", () => {
      if (!socketEnded) return finish();
      // After an end, the END is queued behind any bytes still waiting for credit, within a
      // deadline so a peer that stops returning credit cannot hold the stream's slot.
      const arm = () => {
        stream.cancelDeadline?.();
        stream.cancelDeadline = options.timer(expire, gracefulDrainMs);
      };
      arm();
      stream.progress = arm;
      stream.pending = stream.pending.then(() => {
        stream.progress = undefined;
        stream.cancelDeadline?.();
        stream.cancelDeadline = undefined;
        finish();
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
    const connection = options.socketFactory?.(port);
    if (!connection) throw new Error("Missing host socket factory");
    const { socket } = connection;
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
        // The peer can receive READY and send DATA before send() settles.
        stream.ready = true;
        void send(kinds.ready, id).then(() => {
          if (alive(stream)) ready(stream);
        });
      });
      connection.connect();
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
      pendingPayloadBytes,
      pendingFrameBytes,
      channelBufferedBytes:
        (options.channel.bufferedBytes ?? 0) + (options.channel.bufferedReceiveBytes ?? 0),
      bufferedBytes:
        pendingPayloadBytes +
        pendingFrameBytes +
        (options.channel.bufferedBytes ?? 0) +
        (options.channel.bufferedReceiveBytes ?? 0) +
        [...streams.values()].reduce(
          (n, s) => n + s.socket.readableLength + s.socket.writableLength,
          0,
        ),
      closed,
    }),
  };
}
