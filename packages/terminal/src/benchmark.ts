import { performance } from "node:perf_hooks";
import { fixture, runNode } from "./test-support.ts";

const mib = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(mib) || mib < 1) throw new RangeError("Pass a positive MiB count");
const context = await fixture();
let sampling: ReturnType<typeof setInterval> | undefined;
try {
  context.attachment.detach();
  const offset = context.terminal.snapshot().nextOffset;
  const slow = context.terminal.attach({ fromOffset: offset });
  const memory = process.memoryUsage();
  let peakRss = memory.rss;
  let peakBuffers = memory.arrayBuffers;
  let peakHeap = memory.heapUsed;
  sampling = setInterval(() => {
    const sample = process.memoryUsage();
    peakRss = Math.max(peakRss, sample.rss);
    peakBuffers = Math.max(peakBuffers, sample.arrayBuffers);
    peakHeap = Math.max(peakHeap, sample.heapUsed);
  }, 5);
  const start = performance.now();
  context.terminal.write("exec ");
  runNode(
    context.terminal,
    `const fs=require('node:fs'); const b=Buffer.alloc(65536,120); for(let i=0;i<${mib * 16};i++) fs.writeSync(1,b);`,
  );
  await context.terminal.exited;
  clearInterval(sampling);
  const last = process.memoryUsage();
  peakRss = Math.max(peakRss, last.rss);
  peakBuffers = Math.max(peakBuffers, last.arrayBuffers);
  peakHeap = Math.max(peakHeap, last.heapUsed);
  const seconds = (performance.now() - start) / 1000;
  const snapshot = context.terminal.snapshot();
  const after = process.memoryUsage();
  const stalled = await slow.next();
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        bytes: snapshot.nextOffset - offset,
        seconds,
        mibPerSecond: mib / seconds,
        retainedBytes: Buffer.from(snapshot.data, "base64").length,
        rssDeltaMiB: (after.rss - memory.rss) / 1024 / 1024,
        arrayBufferDeltaMiB: (after.arrayBuffers - memory.arrayBuffers) / 1024 / 1024,
        peakRssDeltaMiB: (peakRss - memory.rss) / 1024 / 1024,
        peakArrayBufferDeltaMiB: (peakBuffers - memory.arrayBuffers) / 1024 / 1024,
        peakHeapDeltaMiB: (peakHeap - memory.heapUsed) / 1024 / 1024,
        stalledReader: stalled.value?.type,
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(sampling);
  await context.cleanup();
}
