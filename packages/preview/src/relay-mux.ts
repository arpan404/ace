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
  /** Bytes the peer sent that wait for the socket: coalesced into the next write. */
  writeQueue: Uint8Array[];
  /** Bytes in `writeQueue` plus the write in flight; their credit returns as they are written. */
  queuedBytes: number;
  /** One write at a time reaches the socket; the next takes everything queued behind it. */
  writing: boolean;
  /** The peer's END came while bytes still waited: the socket ends once they are written. */
  endPending: boolean;
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
/**
 * Bytes the peer may have sent that wait for local sockets, across every stream of one mux.
 * Credit bounds each stream to one window; this bounds the sum below `maxStreams` windows, so a
 * peer that fills every stream while the sockets stop reading costs at most this much. A DATA
 * frame past it resets its stream. The machine tunnel's muxes pass it (ADR 0194); the preview
 * relay's do not, and keep the per-stream window as their only bound.
 */
export const maxQueuedBytes = 32 * 1024 * 1024;
type MuxOptions = {
  channel: PreviewChannel;
  maxStreams: number;
  /**
   * Admits stream `id`'s OPEN for `port` synchronously, before anything is allocated for it;
   * false resets it unopened. `allowPort` still decides afterwards.
   */
  admitOpen?: (port: number, id: number) => boolean;
  /** Bytes queued for local sockets across every stream, past which a DATA resets; no bound unless given. */
  maxQueuedBytes?: number;
  /** Whether to connect stream `id`'s OPEN for `port`; refused, the stream is reset unopened. */
  allowPort?: (port: number, id: number) => Promise<boolean>;
  /**
   * Asked synchronously just before stream `id`'s socket connects and again as it connects,
   * before READY: false resets the stream, which is removed first and never READY.
   */
  canConnect?: (port: number, id: number) => boolean;
  socketFactory?: (port: number, id: number) => { socket: PreviewSocket; connect: () => void };
  onClosed?: () => void;
  /**
   * Stream `id` left the mux, however it ended (refused, reset by either side, finished, or the
   * mux closed): synchronously, before any later frame from the peer is read.
   */
  onStreamRemoved?: (id: number) => void;
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
  let queuedWriteBytes = 0;
  const queueLimit = options.maxQueuedBytes ?? Number.POSITIVE_INFINITY;
  const maxPendingSends = options.maxStreams * 34 + 32;
  let unsubscribe: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    options.channel.close();
    const removed = [...streams.values()];
    streams.clear();
    for (const stream of removed) {
      stream.cancelDeadline?.();
      stream.socket.destroy();
      stream.wake?.();
      stream.cancelSend?.();
      options.onStreamRemoved?.(stream.id);
    }
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
    queuedWriteBytes -= stream.queuedBytes;
    stream.queuedBytes = 0;
    stream.writeQueue.length = 0;
    stream.socket.destroy();
    options.onStreamRemoved?.(stream.id);
  };
  /**
   * Writes what the peer sent, one write per stream at a time: frames that arrive while one is
   * in flight are joined into the next, so a peer sending one-byte frames to a socket that stops
   * reading leaves one pending write and one buffer, not one callback per frame. Credit returns
   * as each write completes, for all the bytes it carried.
   */
  const flush = (stream: Stream) => {
    if (stream.writing || !alive(stream)) return;
    const chunks = stream.writeQueue.splice(0);
    if (chunks.length === 0) {
      if (stream.endPending) {
        stream.endPending = false;
        stream.socket.end();
      }
      return;
    }
    const bytes = chunks.length === 1 && chunks[0] ? chunks[0] : joined(chunks);
    stream.writing = true;
    stream.socket.write(bytes, (error) => {
      if (!alive(stream)) return;
      stream.writing = false;
      stream.queuedBytes -= bytes.byteLength;
      queuedWriteBytes -= bytes.byteLength;
      if (error) return;
      stream.receiveCredit += bytes.byteLength;
      void send(kinds.credit, stream.id, bytes.byteLength).catch(close);
      flush(stream);
    });
  };
  /**
   * A RESET after the peer's END is its socket closing once it had sent everything (a server that
   * closes after its answer, while this side has not ended): what it sent before the END stands.
   * The bytes still queued go to the socket in one write, past its backpressure (at most one
   * window, already counted), then its end, before the stream is removed. The client's tunnel
   * stream keeps what it was given once it has ended, whatever destroy follows; a machine-side
   * socket never meets this, since a client stream sends no RESET after its END.
   */
  const deliverRest = (stream: Stream) => {
    const chunks = stream.writeQueue.splice(0);
    if (chunks.length > 0)
      stream.socket.write(chunks.length === 1 && chunks[0] ? chunks[0] : joined(chunks), () => {});
    if (stream.endPending) {
      stream.endPending = false;
      stream.socket.end();
    }
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
          // A send that failed closed the channel; this wait still ends.
          void writing
            .finally(() => {
              stream.cancelSend = undefined;
              resolve();
            })
            .catch(() => {});
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
      writeQueue: [],
      queuedBytes: 0,
      writing: false,
      endPending: false,
      progress: undefined,
      cancelDeadline: undefined,
    };
    streams.set(id, stream);
    socket.pause();
    socket.on("data", (chunk: Uint8Array) => {
      if (!alive(stream)) return;
      if (stream.payloadBytes || !SocketChunk.safeParse(chunk).success) {
        remove(stream);
        void send(kinds.reset, id).catch(close);
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
      void send(kinds.reset, id).catch(close);
      remove(stream);
    });
    const finish = () => {
      if (!alive(stream)) return;
      remove(stream);
      if (!stream.incomingEnded || !stream.outgoingEnded) void send(kinds.reset, id).catch(close);
    };
    const expire = () => {
      if (!alive(stream)) return;
      void send(kinds.reset, id).catch(close);
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
    const connection = options.socketFactory?.(port, id);
    if (!connection) throw new Error("Missing host socket factory");
    const { socket } = connection;
    if (closed) {
      socket.destroy();
      return;
    }
    const stream = bind(id, socket);
    try {
      if (!(await options.allowPort?.(port, id)) || !alive(stream)) {
        // Removed first, so the slot is free before the peer can hear the RESET and open again.
        remove(stream);
        await send(kinds.reset, id);
        return;
      }
      const refuse = () => {
        remove(stream);
        void send(kinds.reset, id).catch(close);
      };
      if (options.canConnect && !options.canConnect(port, id)) return refuse();
      socket.once("connect", () => {
        if (!alive(stream)) return;
        // Nothing runs between this check and READY: a refused stream is never READY.
        if (options.canConnect && !options.canConnect(port, id)) return refuse();
        // The peer can receive READY and send DATA before send() settles.
        stream.ready = true;
        void send(kinds.ready, id)
          .then(() => {
            if (alive(stream)) ready(stream);
          })
          .catch(close);
      });
      connection.connect();
    } catch {
      remove(stream);
      await send(kinds.reset, id);
    }
  };
  const receive = (input: Uint8Array) => {
    try {
      const frame = decodeFrame(input);
      if (frame.kind === kinds.open) {
        if (!options.allowPort || frame.id <= lastId) throw new Error("Invalid stream open");
        lastId = frame.id;
        const port = PreviewPort.parse(frame.value);
        if (streams.size >= options.maxStreams || options.admitOpen?.(port, frame.id) === false) {
          void send(kinds.reset, frame.id).catch(close);
          return;
        }
        void accept(frame.id, port).catch(close);
        return;
      }
      const stream = streams.get(frame.id);
      if (!stream) return; // Late frames for a locally reset stream cannot revive it.
      if (frame.kind === kinds.reset) {
        if (stream.incomingEnded) deliverRest(stream);
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
        if (queuedWriteBytes + frame.value > queueLimit) {
          remove(stream);
          void send(kinds.reset, stream.id).catch(close);
          return;
        }
        stream.writeQueue.push(frame.data);
        stream.queuedBytes += frame.value;
        queuedWriteBytes += frame.value;
        flush(stream);
      } else if (frame.kind === kinds.end) {
        if (stream.incomingEnded) throw new Error("Duplicate stream end");
        stream.incomingEnded = true;
        // After the bytes still waiting to be written, never ahead of them.
        stream.endPending = true;
        flush(stream);
      }
    } catch {
      close();
    }
  };
  unsubscribe = options.channel.subscribe(receive, close);
  if (closed) unsubscribe();
  return {
    /** Opens a stream for `socket`: its id, or undefined when it was destroyed unopened. */
    open(socket: PreviewSocket, port: number): number | undefined {
      if (
        options.allowPort ||
        closed ||
        streams.size >= options.maxStreams ||
        nextId > 0xffffffff
      ) {
        socket.destroy();
        return undefined;
      }
      const id = nextId++;
      bind(id, socket);
      void send(kinds.open, id, PreviewPort.parse(port)).catch(close);
      return id;
    },
    /** Resets stream `id` at once, whatever state it is in; an unknown id changes nothing. */
    reset(id: number): void {
      const stream = streams.get(id);
      if (!stream || closed) return;
      remove(stream);
      void send(kinds.reset, id).catch(close);
    },
    close,
    // Observability reports counts and windows, never retained payloads.
    stats: () => ({
      streams: streams.size,
      pendingPayloadBytes,
      queuedWriteBytes,
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

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
