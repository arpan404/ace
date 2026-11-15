import { NoiseNK, keyPair } from "@ace/secure-channel";
import type { KeyPair, SessionKeys } from "@ace/secure-channel";
import type { WebSocket } from "ws";
import type { HostChannel } from "./channel.ts";
import type { Clock } from "./clock.ts";
import { sendFrame } from "./socket.ts";
import { NK_STREAM_PROLOGUE } from "./wire.ts";

/*
 * The daemon's side of a relay stream opened with Noise NK (ADR 0155, step 2). The relay
 * package runs the handshake; the daemon decides, through `NkHost`, whether the first message's
 * early hello is admitted. Refusals, for any reason, look the same: the stream closes with
 * nothing sent, `refusalDelay` after the first message arrived.
 */

/** An XX first message is exactly this long; anything longer is read as NK. */
export const XX_FIRST_MESSAGE = 32;

export type NkAccepted = {
  /** Runs the admitted session on the channel that now carries it. */
  open(channel: HostChannel): void | Promise<void>;
  /** The answer couldn't be sent: give back what was taken for the session. */
  abandon(): void;
};

export interface NkHost {
  /** Before decryption: may the daemon spend work on one more first message? */
  arrive(): boolean;
  /** The decrypted early payload and its ephemeral key: admitted, or undefined for refused. */
  admit(payload: Uint8Array, ephemeral: Uint8Array): Promise<NkAccepted | undefined>;
  /** How long after `arrivedAt` a refusal goes out. */
  refusalDelay(arrivedAt: number): number;
}

export type NkAnswer = { keys: SessionKeys; accepted: NkAccepted } | undefined;

/**
 * Reads `first` as an NK first message and, once the daemon admits it, sends the answer before
 * anything else on the stream. Undefined when refused; the socket is closed by then.
 */
export async function answerNk(
  socket: WebSocket,
  first: Uint8Array,
  options: { host: NkHost; staticKey: KeyPair; clock: Clock; signal: AbortSignal },
): Promise<NkAnswer> {
  const arrivedAt = options.clock.now();
  const refuse = async (): Promise<undefined> => {
    const wait = options.host.refusalDelay(arrivedAt);
    await new Promise<void>((resolve) => {
      const cancel = options.clock.schedule(wait, finish);
      function finish() {
        cancel();
        options.signal.removeEventListener("abort", finish);
        resolve();
      }
      options.signal.addEventListener("abort", finish, { once: true });
    });
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
  let accepted: NkAccepted | undefined;
  try {
    const payload = state.readMessage(first);
    const ephemeral = state.remoteEphemeral;
    try {
      accepted = ephemeral ? await options.host.admit(payload, ephemeral) : undefined;
    } finally {
      payload.fill(0);
    }
  } catch {
    accepted = undefined;
  }
  if (!accepted || options.signal.aborted) {
    accepted?.abandon();
    state.destroy();
    return refuse();
  }
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
