import { performance } from "node:perf_hooks";
import { BrowserInput } from "@ace/protocol";
import { keyEvent } from "../src/keyboard.ts";
import { PolicyGate } from "../src/policy-call.ts";

const input = BrowserInput.parse({
  kind: "key",
  event: "keyDown",
  key: "Backspace",
  code: "Backspace",
});
if (input.kind !== "key") throw new Error("Expected keyboard input");
const iterations = 100_000;
const start = performance.now();
for (let i = 0; i < iterations; i++) keyEvent(input);
let elapsed = performance.now() - start;
console.log(
  JSON.stringify({
    path: "validated key translation",
    iterations,
    opsPerSecond: Math.round((iterations / elapsed) * 1000),
    microseconds: (elapsed * 1000) / iterations,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  }),
);
const gate = new PolicyGate();
const controller = new AbortController();
const policyStart = performance.now();
for (let i = 0; i < iterations; i++) await gate.run(controller.signal, () => true);
elapsed = performance.now() - policyStart;
console.log(
  JSON.stringify({
    path: "approval admission and settled hook",
    iterations,
    opsPerSecond: Math.round((iterations / elapsed) * 1000),
    microseconds: (elapsed * 1000) / iterations,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  }),
);
const held = Promise.withResolvers<boolean>();
const { setMaxListeners } = await import("node:events");
setMaxListeners(33, controller.signal);
const blocked = Array.from({ length: 32 }, () =>
  gate.run(controller.signal, () => held.promise).catch(() => false),
);
const overloadStart = performance.now();
for (let i = 0; i < iterations; i++)
  await gate.run(controller.signal, () => true).catch(() => false);
elapsed = performance.now() - overloadStart;
console.log(
  JSON.stringify({
    path: "approval overload rejection without hook/timer",
    iterations,
    opsPerSecond: Math.round((iterations / elapsed) * 1000),
    microseconds: (elapsed * 1000) / iterations,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  }),
);
controller.abort();
held.resolve(false);
await Promise.all(blocked);
