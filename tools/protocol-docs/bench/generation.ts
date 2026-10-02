import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { checkFiles, convertSchemas, protocolCatalog, renderReference } from "../src/index.ts";

const catalog = protocolCatalog();
const root = fileURLToPath(new URL("../../../docs/protocol/", import.meta.url));
const count = 10;
const started = performance.now();
let conversionMs = 0,
  renderingMs = 0,
  fileCheckMs = 0;
for (let i = 0; i < count; i++) {
  const converting = performance.now();
  const snapshot = convertSchemas(catalog.entries);
  conversionMs += performance.now() - converting;
  const rendering = performance.now();
  const files = renderReference(catalog.entries, catalog.tools, snapshot);
  renderingMs += performance.now() - rendering;
  const checking = performance.now();
  const stale = await checkFiles(root, files);
  fileCheckMs += performance.now() - checking;
  if (stale.length) throw new Error(`Run bun run docs:protocol first: ${stale.join(", ")}`);
}
const elapsed = performance.now() - started;
console.log(
  JSON.stringify(
    {
      schemas: catalog.entries.length,
      iterations: count,
      checksPerSecond: Number(((count * 1000) / elapsed).toFixed(2)),
      millisecondsPerCheck: Number((elapsed / count).toFixed(2)),
      conversionMs: Number((conversionMs / count).toFixed(2)),
      renderingMs: Number((renderingMs / count).toFixed(2)),
      fileCheckMs: Number((fileCheckMs / count).toFixed(2)),
      peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
    },
    null,
    2,
  ),
);
