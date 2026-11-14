import { CipherState } from "../src/cipher.ts";
import { FlowCredit, fragmentCost, readCredit } from "../src/flow-credit.ts";
import { jsonValue, writeVectors } from "../../browser/scripts/media-vector-harness.ts";
type Side = { key: Uint8Array; nonce: bigint; frames: bigint };
function side(seed: number, nonce: bigint, frames: bigint): Side {
  return { key: Uint8Array.from({ length: 32 }, (_, i) => (seed + i * 7) & 255), nonce, frames };
}
function state(s: Side) {
  return { ...s, nonce: `${s.nonce}`, frames: `${s.frames}` };
}
/**
 * A stream handed over mid-flight: each direction has its own key, nonce and frame
 * count, so the two directions rekey at different points of the interleaved transcript.
 */
function handover() {
  const interval = 16n;
  const send = side(11, 0x100000000n + 7n, 13n);
  const receive = side(200, 42n, 5n);
  const ciphers = {
    send: new CipherState(send.key, send.nonce),
    receive: new CipherState(receive.key, receive.nonce),
  };
  const frames = { send: send.frames, receive: receive.frames };
  const steps = Array.from({ length: 60 }, (_, index) => {
    const direction = index % 3 === 2 ? "receive" : "send";
    const plain = new Uint8Array([3, index, direction === "send" ? 1 : 2]);
    const sealed = ciphers[direction].encrypt(plain);
    frames[direction]++;
    const rekey = frames[direction] % interval === 0n;
    if (rekey) ciphers[direction].rekey();
    return { index, direction, plain, sealed, rekey };
  });
  ciphers.send.destroy();
  ciphers.receive.destroy();
  return { rekeyInterval: 16, send: state(send), receive: state(receive), steps };
}
export function mediaVectors() {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  const cipher = new CipherState(key, 0x100000000n);
  const decryptor = new CipherState(key, 0x100000000n);
  const noise = Array.from({ length: 35 }, (_, index) => {
    const plain = new Uint8Array([3, index, 255 - index]);
    const sealed = cipher.encrypt(plain);
    const opened = decryptor.decrypt(sealed);
    const rekey = (index + 1) % 16 === 0;
    if (rekey) {
      cipher.rekey();
      decryptor.rekey();
    }
    return { index, plain, sealed, opened, rekey };
  });
  cipher.destroy();
  decryptor.destroy();
  const flow = new FlowCredit();
  const start = flow.start();
  flow.credited(0);
  const steps = Array.from({ length: 80 }, (_, i) => {
    const cost = fragmentCost(i % 2 === 0 ? 17 : 65519);
    const allowed = flow.allows(cost);
    if (allowed) flow.spend(cost);
    const accepted = flow.received(cost);
    const credit = flow.consumed(cost);
    if (credit) flow.credited(readCredit(credit));
    return {
      input: { cost },
      output: { allowed, accepted, credit, limited: flow.limited, counting: flow.counting },
    };
  });
  return {
    noise: jsonValue({ key, initialNonce: "4294967296", rekeyInterval: 16, steps: noise }),
    "flow-credit": jsonValue({ start, steps }),
    "noise-handover": jsonValue(handover()),
  };
}
if (import.meta.main) writeVectors(mediaVectors());
