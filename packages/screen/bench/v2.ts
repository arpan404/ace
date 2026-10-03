import { performance } from "node:perf_hooks";
import { FrameDecoder } from "../src/frames.ts";
import { parseUITree } from "../src/ui-results.ts";
function measure(name: string, count: number, operation: () => void): void {
  const start = performance.now();
  for (let i = 0; i < count; i++) operation();
  console.log(`${name}: ${(((performance.now() - start) * 1000) / count).toFixed(2)} us/op`);
}
const payload = Buffer.alloc(128 * 1024);
const header = Buffer.from(
  JSON.stringify({
    version: 2,
    sessionId: "bench",
    seq: 0,
    ts: 1000,
    width: 1280,
    height: 720,
    scale: 1.5,
    codec: "jpeg",
    bytes: payload.length,
  }),
);
const prefix = Buffer.alloc(4);
prefix.writeUInt32BE(header.length);
const packet = Buffer.concat([prefix, header, payload]);
let received = 0;
measure("fragmented v2 JPEG packet", 1000, () => {
  const decoder = new FrameDecoder(() => {
    received++;
  });
  for (let offset = 0; offset < packet.length; offset += 4096)
    decoder.push(packet.subarray(offset, offset + 4096));
  decoder.end();
});
const node = {
  ref: "n",
  role: "button",
  name: "Save",
  bounds: { x: 0, y: 0, w: 20, h: 20 },
  states: [],
  actions: ["press"],
  children: [],
};
const tree = {
  root: { ...node, children: Array.from({ length: 255 }, (_, i) => ({ ...node, ref: `n${i}` })) },
  truncated: false,
};
measure("validate 256-node UI reply", 1000, () => {
  parseUITree(tree, 256, 8);
});
console.log(
  JSON.stringify({
    received,
    rssBytes: process.memoryUsage().rss,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
