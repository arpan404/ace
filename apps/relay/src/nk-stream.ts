import { NoiseNK, keyPair } from "@ace/secure-channel";
import type { KeyPair, SessionKeys } from "@ace/secure-channel";
import type { WebSocket } from "ws";
import type { HostChannel } from "./channel.ts";
import type { Clock } from "./clock.ts";
import { sendFrame } from "./socket.ts";
import { NK_REFUSAL_MS, NK_STREAM_PROLOGUE } from "./wire.ts";

/*
 * The daemon's side of a relay stream opened with Noise NK (ADR 0155, step 2). The relay
 * package runs the handshake; the daemon decides, through `NkHost`, whether the first message's
 * early hello is admitted. Refusals, for any reason, look the same: the stream closes with
 * nothing sent, `NK_REFUSAL_MS` after the first message arrived.
 */

/** An XX first message is exactly this long; anything longer is read as NK. */
export const XX_FIRST_MESSAGE = 32;
const noop = () => {};

export type NkAccepted = {
  /** Runs the admitted session on the channel that now carries it. */
  open(channel: HostChannel): void | Promise<void>;
  /** The answer couldn't be sent: give back what was taken for the session. */
  abandon(): void;
};

export interface NkHost {
  /** Before decryption: may the daemon spend work on one more first message? */
  arrive(): boolean;
  /**
   * The decrypted early payload and its ephemeral key: admitted, or undefined for refused. An
   * answer that comes after the refusal deadline is abandoned: the stream is refused by then.
   */
  admit(payload: Uint8Array, ephemeral: Uint8Array): Promise<NkAccepted | undefined>;
}

export type NkAnswer = { keys: SessionKeys; accepted: NkAccepted } | undefined;

/** Resolves `NK_REFUSAL_MS` after `arrivedAt`, or at once when `signal` ends. */
export function refusalDeadline(
  clock: Clock,
  arrivedAt: number,
  signal: AbortSignal,
): { reached: Promise<"refused">; cancel(): void } {
  let cancel: () => void = noop;
  const reached = new Promise<"refused">((resolve) => {
    const finish = () => {
      stop();
      signal.removeEventListener("abort", finish);
      resolve("refused");
    };
    const stop = clock.schedule(Math.max(0, arrivedAt + NK_REFUSAL_MS - clock.now()), finish);
    signal.addEventListener("abort", finish, { once: true });
    cancel = () => {
      stop();
      signal.removeEventListener("abort", finish);
    };
  });
  return { reached, cancel };
}

/**
 * Reads `first` as an NK first message and, once the daemon admits it, sends the answer before
 * anything else on the stream. Undefined when refused; the socket is closed by then, at the one
 * refusal time after `arrivedAt` whatever the reason.
 */
export async function answerNk(
  socket: WebSocket,
  first: Uint8Array,
  options: {
    host: NkHost;
    staticKey: KeyPair;
    clock: Clock;
    signal: AbortSignal;
    arrivedAt: number;
  },
): Promise<NkAnswer> {
  const deadline = refusalDeadline(options.clock, options.arrivedAt, options.signal);
  const refuse = async (): Promise<undefined> => {
    await deadline.reached;
    socket.terminate();
    return undefined;
  };
  // Over the daemon's rate: refused without decrypting.
  if (!options.host.arrive()) return refuse();
  const state = NoiseNK.responder({
    staticKey: options.staticKey,
    ephemeralKey: keyPair(),
    prologue: NK_STREAM_PROLOGUE,
  });
  let admitting: Promise<NkAccepted | undefined>;
  try {
    const payload = state.readMessage(first);
    const ephemeral = state.remoteEphemeral;
    admitting = ephemeral
      ? options.host.admit(payload, ephemeral).catch(() => undefined)
      : Promise.resolve(undefined);
    void admitting.finally(() => payload.fill(0));
  } catch {
    state.destroy();
    return refuse();
  }
  const outcome = await Promise.race([admitting, deadline.reached]);
  if (outcome === "refused" || !outcome || options.signal.aborted) {
    // Admitted too late: give its session back; the stream is refused on time either way.
    if (outcome === "refused") void admitting.then((late) => late?.abandon());
    else outcome?.abandon();
    state.destroy();
    return refuse();
  }
  deadline.cancel();
  const accepted = outcome;
  try {
    // The answer goes first: nothing is queued on this stream before it.
    await sendFrame(socket, state.writeMessage());
    return { keys: state.transport, accepted };
  } catch {
    accepted.abandon();
    state.destroy();
    socket.terminate();
    return undefined;
  }
}
