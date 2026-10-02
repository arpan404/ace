import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { checkFiles, convertSchemas, protocolCatalog, renderReference } from "../src/index.ts";

const catalog = protocolCatalog();
const root = fileURLToPath(new URL("../../../docs/protocol/", import.meta.url));
const count = 10;
const started = performance.now();
for (let i = 0; i < count; i++) {
  const snapshot = convertSchemas(catalog.entries);
  const files = renderReference(catalog.entries, catalog.tools, snapshot);
  const stale = await checkFiles(root, files);
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
      peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
    },
    null,
    2,
  ),
);
