import { PreviewPort } from "@ace/protocol/preview";
import { z } from "zod";
import { decodeFrame, encodeFrame, frameSize, kinds, windowSize } from "./relay-wire.ts";
import {
  openState,
  transition,
  type LifecycleEvent,
  type StreamRemoval,
  type StreamState,
} from "./stream-lifecycle.ts";

export type { StreamRemoval } from "./stream-lifecycle.ts";

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
 * Native bridges expose bounded socket queues and Node-like stream events. Each stream closes as
 * a TCP connection does (`stream-lifecycle.ts`), and the mux alone decides when: a socket only
 * reports what happened to it and does what the mux asks. `end` is the socket's FIN, handed over
 * behind every byte read before it, and the mux sends END behind them. `close` after `end` is
 * graceful; `hangup` is a close after the FIN was read while bytes before it are still being
 * handed over (`end` follows them). `close` before `end`, `error`, a failed write and `abort`
 * (the local side giving up, after its end too) reset the stream at once. A stream finishes
 * without a RESET only once both ENDs are exchanged, everything the peer sent has been written,
 * and the socket has closed. A socket that closes with the stream unfinished leaves it waiting
 * for what is still owed (its last bytes and our END going, the peer's END) for at most
 * `gracefulDrainMs` from the close, a deadline nothing extends; peer DATA then resets it, since
 * nothing reads it. `destroy` is called once, as the stream leaves the mux, with how it left.
 */
export type PreviewSocket = {
  readonly readableLength: number;
  readonly writableLength: number;
  pause(): unknown;
  resume(): unknown;
  destroy(removal: StreamRemoval): unknown;
  end(): unknown;
  write(bytes: Uint8Array, callback: (error?: Error | null) => void): unknown;
  on(event: "data", listener: (bytes: Uint8Array) => void): unknown;
  on(event: "end" | "close" | "hangup" | "error" | "abort", listener: () => void): unknown;
  once(event: "connect", listener: () => void): unknown;
};
type Stream = {
  id: number;
  socket: PreviewSocket;
  ready: boolean;
  sendCredit: number;
  receiveCredit: number;
  /** Where the stream is in its close (`stream-lifecycle.ts`). */
  state: StreamState;
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
  cancelDeadline: (() => void) | undefined;
};
/** Runs `run` after `ms` unless the returned cancel is called first. */
export type MuxTimer = (run: () => void, ms: number) => () => void;
export const systemTimer: MuxTimer = (run, ms) => {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
};
/**
 * How long a stream whose socket closed after its end may wait for what it is still owed (our END
 * going behind its last bytes, the peer's END) before it is reset. Fixed from the close: no frame
 * extends it, so a peer that only returns CREDIT cannot hold the slot. It matches the relay's
 * other wait-for-the-peer bounds (bridge authentication and request headers, 15 s).
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
    // The same removal as a RESET, so queued bytes and their accounting go with each stream
    // (deleting from a Map while iterating it is safe: deleted entries are not visited).
    for (const stream of streams.values()) remove(stream, "reset");
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
  const remove = (stream: Stream, removal: StreamRemoval) => {
    if (streams.get(stream.id) !== stream) return;
    streams.delete(stream.id);
    stream.state = "gone";
    stream.cancelDeadline?.();
    stream.wake?.();
    stream.cancelSend?.();
    queuedWriteBytes -= stream.queuedBytes;
    stream.queuedBytes = 0;
    stream.writeQueue.length = 0;
    stream.socket.destroy(removal);
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
      if (stream.queuedBytes === 0) apply(stream, "writesDrained");
      return;
    }
    const bytes = chunks.length === 1 && chunks[0] ? chunks[0] : joined(chunks);
    stream.writing = true;
    stream.socket.write(bytes, (error) => {
      if (!alive(stream)) return;
      stream.writing = false;
      stream.queuedBytes -= bytes.byteLength;
      queuedWriteBytes -= bytes.byteLength;
      // Bytes the socket never took can't be delivered: the stream is aborted, whether or not
      // the socket reports anything else.
      if (error) return apply(stream, "localAbort");
      stream.receiveCredit += bytes.byteLength;
      void send(kinds.credit, stream.id, bytes.byteLength).catch(close);
      flush(stream);
    });
  };
  /** Bytes the peer sent, for a stream the lifecycle lets queue them. */
  const queue = (stream: Stream, data: Uint8Array) => {
    if (data.byteLength > stream.receiveCredit) throw new Error("Receive window exceeded");
    stream.receiveCredit -= data.byteLength;
    if (queuedWriteBytes + data.byteLength > queueLimit) return apply(stream, "localAbort");
    stream.writeQueue.push(data);
    stream.queuedBytes += data.byteLength;
    queuedWriteBytes += data.byteLength;
    flush(stream);
  };
  /**
   * Moves `stream` through its lifecycle and performs what that asks. The state is set before
   * any action runs, so an action that causes another event (a write that completes at once, a
   * socket that closes as it ends) sees it.
   */
  const apply = (stream: Stream, event: LifecycleEvent, data?: Uint8Array): void => {
    if (!alive(stream)) return;
    const { next, actions } = transition(stream.state, event);
    stream.state = next;
    for (const action of actions) {
      if (action === "protocolError") throw new Error(`Stream ${event} breaks its lifecycle`);
      if (action === "reset") {
        // Removed first, so the slot is free before the peer can hear the RESET and open again.
        remove(stream, "reset");
        void send(kinds.reset, stream.id).catch(close);
      } else if (action === "drop") remove(stream, "reset");
      else if (action === "finish") remove(stream, "finished");
      else if (action === "queueData" && data) queue(stream, data);
      else if (action === "endSocket") stream.socket.end();
      else if (action === "armDeadline")
        stream.cancelDeadline = options.timer(() => apply(stream, "deadline"), gracefulDrainMs);
      else if (action === "sendEnd")
        // Behind every byte read before the end, never ahead of them.
        stream.pending = stream.pending.then(async () => {
          if (!alive(stream)) return;
          await send(kinds.end, stream.id);
          apply(stream, "endSent");
        });
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
      state: openState,
      pending: Promise.resolve(),
      wake: undefined,
      cancelSend: undefined,
      payloadBytes: 0,
      writeQueue: [],
      queuedBytes: 0,
      writing: false,
      cancelDeadline: undefined,
    };
    streams.set(id, stream);
    socket.pause();
    socket.on("data", (chunk: Uint8Array) => {
      if (!alive(stream)) return;
      if (stream.payloadBytes || !SocketChunk.safeParse(chunk).success)
        return apply(stream, "localAbort");
      socket.pause();
      stream.pending = transmit(stream, chunk).catch(close);
    });
    // A close before the socket's end is abortive; the lifecycle tells the two apart.
    socket.on("end", () => apply(stream, "localEnd"));
    socket.on("close", () => apply(stream, "localClose"));
    socket.on("hangup", () => apply(stream, "localHangup"));
    socket.on("error", () => apply(stream, "localAbort"));
    socket.on("abort", () => apply(stream, "localAbort"));
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
      socket.destroy("reset");
      return;
    }
    const stream = bind(id, socket);
    try {
      if (!(await options.allowPort?.(port, id)) || !alive(stream)) {
        // Removed first, so the slot is free before the peer can hear the RESET and open again.
        remove(stream, "reset");
        await send(kinds.reset, id);
        return;
      }
      const refuse = () => {
        remove(stream, "reset");
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
      remove(stream, "reset");
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
      if (frame.kind === kinds.reset) return apply(stream, "peerReset");
      if (frame.kind === kinds.ready) {
        if (options.allowPort || stream.ready) throw new Error("Duplicate stream ready");
        ready(stream);
        return;
      }
      if (!stream.ready) throw new Error("Data before ready");
      if (frame.kind === kinds.credit) {
        // Against what this side sent and the peer has not acknowledged, in every state.
        if (!frame.value || stream.sendCredit + frame.value > windowSize)
          throw new Error("Invalid stream credit");
        stream.sendCredit += frame.value;
        stream.wake?.();
        apply(stream, "peerCredit");
      } else if (frame.kind === kinds.data) apply(stream, "peerData", frame.data);
      else if (frame.kind === kinds.end) apply(stream, "peerEnd");
    } catch {
      close();
    }
  };
  unsubscribe = options.channel.subscribe(receive, close);
  if (closed) unsubscribe();
  return {
    /**
     * Opens a stream for `socket`: its id, or undefined when it was destroyed unopened.
     * `opening` hears the id before the OPEN goes, since a channel may deliver the peer's answer
     * (a RESET, say) before `open` returns.
     */
    open(socket: PreviewSocket, port: number, opening?: (id: number) => void): number | undefined {
      if (
        options.allowPort ||
        closed ||
        streams.size >= options.maxStreams ||
        nextId > 0xffffffff
      ) {
        socket.destroy("reset");
        return undefined;
      }
      const id = nextId++;
      const target = PreviewPort.parse(port);
      bind(id, socket);
      opening?.(id);
      void send(kinds.open, id, target).catch(close);
      return id;
    },
    /** Resets stream `id` at once, whatever state it is in; an unknown id changes nothing. */
    reset(id: number): void {
      const stream = streams.get(id);
      if (!stream || closed) return;
      apply(stream, "localAbort");
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
