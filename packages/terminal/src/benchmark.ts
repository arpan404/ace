import { performance } from "node:perf_hooks";
import { fixture, runNode } from "./test-support.ts";

const mib = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(mib) || mib < 1) throw new RangeError("Pass a positive MiB count");
const context = await fixture();
try {
  context.attachment.detach();
  const offset = context.terminal.snapshot().nextOffset;
  const slow = context.terminal.attach({ fromOffset: offset });
  const memory = process.memoryUsage();
  const start = performance.now();
  context.terminal.write("exec ");
  runNode(
    context.terminal,
    `const fs=require('node:fs'); const b=Buffer.alloc(65536,120); for(let i=0;i<${mib * 16};i++) fs.writeSync(1,b);`,
  );
  await context.terminal.exited;
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
        stalledReader: stalled.value?.type,
      },
      null,
      2,
    ),
  );
} finally {
  await context.cleanup();
}
