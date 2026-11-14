import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { CipherState } from "@ace/secure-channel";
import { clientMessageChannel } from "../src/channel.ts";
import { FrameReader } from "../src/socket.ts";
import { jsonValue, writeVectors } from "../../../packages/browser/scripts/media-vector-harness.ts";
class TranscriptCipher extends CipherState {
  #frames = 0;
  override encrypt(plain: Uint8Array, ad?: Uint8Array): Uint8Array {
    const sealed = super.encrypt(plain, ad);
    if (++this.#frames % 16 === 0) this.rekey();
    return sealed;
  }
  override decrypt(sealed: Uint8Array, ad?: Uint8Array): Uint8Array {
    const plain = super.decrypt(sealed, ad);
    if (++this.#frames % 16 === 0) this.rekey();
    return plain;
  }
}
/** The production fragmenter and credit exchange, with deterministic socket boundaries. */
export async function mediaVectors() {
  const key = Uint8Array.from({ length: 32 }, (_, i) => 31 - i);
  const frames: { direction: string; sealed: Uint8Array }[] = [];
  const left = new EventEmitter(),
    right = new EventEmitter();
  function endpoint(events: EventEmitter, peer: EventEmitter, direction: string) {
    return Object.assign(events, {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send(frame: Uint8Array, _options: unknown, done: () => void) {
        frames.push({ direction, sealed: frame.slice() });
        peer.emit("message", Buffer.from(frame), true);
        done();
      },
      terminate() {
        events.emit("close", 1000, Buffer.alloc(0));
      },
      pause() {},
      resume() {},
    }) as unknown as WebSocket;
  }
  function transport() {
    const send = new TranscriptCipher(key),
      receive = new TranscriptCipher(key);
    return {
      send,
      receive,
      handshakeHash: new Uint8Array(32),
      remoteStatic: new Uint8Array(32),
      destroy() {
        send.destroy();
        receive.destroy();
      },
    };
  }
  const a = endpoint(left, right, "send"),
    b = endpoint(right, left, "receive");
  const sender = clientMessageChannel(a, new FrameReader(a), transport());
  const receiver = clientMessageChannel(b, new FrameReader(b), transport());
  sender.flowControl?.();
  receiver.flowControl?.();
  const inputs = [
    ...Array.from({ length: 6 }, () => 65520),
    ...Array.from({ length: 17 }, () => 3),
  ];
  const opened: Uint8Array[] = [];
  try {
    for (const length of inputs) {
      await sender.sendBinary(new Uint8Array(length).fill(7));
      opened.push(await receiver.receiveBinary());
    }
    await receiver.sendBinary(new Uint8Array([9, 8, 7]));
    opened.push(await sender.receiveBinary());
  } finally {
    sender.close();
    receiver.close();
    await sender.closed;
    await receiver.closed;
  }
  return {
    fragmenting: jsonValue({
      key,
      rekeyInterval: 16,
      flowControl: true,
      inputs: inputs.map((length) => ({ length, byte: 7 })),
      reply: [9, 8, 7],
      frames,
      opened,
    }),
  };
}
if (import.meta.main) writeVectors(await mediaVectors());
