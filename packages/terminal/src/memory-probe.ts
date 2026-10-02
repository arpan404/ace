import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { fixture, runNode } from "./test-support.ts";

// Run in an isolated Node process with --expose-gc. Output/read handshakes let
// every sample measure live retained allocations, independent of GC timing.
if (!global.gc) throw new Error("Run the memory probe with --expose-gc");
const context = await fixture({ scrollbackBytes: 64 * 1024 });
try {
  context.attachment.detach();
  const offset = context.terminal.snapshot().nextOffset;
  const slow = context.terminal.attach({ fromOffset: offset });
  global.gc();
  const baseline = process.memoryUsage();
  const initial = baseline.heapUsed + baseline.arrayBuffers;
  let peak = initial;
  context.terminal.write("exec ");
  runNode(
    context.terminal,
    "const fs=require('node:fs');process.stdin.setRawMode(true);const b=Buffer.alloc(65536,120);let i=0;function send(){for(let at=0;at<b.length;)at+=fs.writeSync(1,b,at,b.length-at);i++}process.stdin.on('data',()=>{if(i===320)process.exit(0);else send()});send()",
  );
  let ended = false;
  void context.terminal.exited.then(() => {
    ended = true;
  });
  for (let block = 1; block <= 320; block++) {
    while (context.terminal.snapshot().nextOffset < offset + block * 65536) {
      if (ended) throw new Error("Producer exited before output barrier");
      await setImmediate();
    }
    global.gc();
    const memory = process.memoryUsage();
    peak = Math.max(peak, memory.heapUsed + memory.arrayBuffers);
    assert(
      peak - initial < 8 * 1024 * 1024,
      "Live PTY allocations grew beyond the bounded working set",
    );
    context.terminal.write("x");
  }
  await context.terminal.exited;
  assert.equal(context.terminal.snapshot().nextOffset - offset, 20 * 1024 * 1024);
  assert.equal((await slow.next()).value?.type, "resync");
  console.log(`BOUNDED_20_MIB peakLiveDeltaBytes=${peak - initial}`);
} finally {
  await context.cleanup();
}
