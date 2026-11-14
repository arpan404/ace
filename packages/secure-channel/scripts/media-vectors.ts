import { CipherState } from "../src/cipher.ts";
import { FlowCredit, fragmentCost, readCredit } from "../src/flow-credit.ts";
import { jsonValue, writeVectors } from "../../browser/scripts/media-vector-harness.ts";
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
  };
}
if (import.meta.main) writeVectors(mediaVectors());
