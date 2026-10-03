import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  checkFiles,
  convertSchemas,
  protocolCatalog,
  renderReference,
  withManifest,
  sourceFingerprint,
  checkFingerprint,
} from "../src/index.ts";

const catalog = protocolCatalog();
const root = fileURLToPath(new URL("../../../docs/protocol/", import.meta.url));
const count = 10;
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const started = performance.now();
let conversionMs = 0,
  renderingMs = 0,
  fileCheckMs = 0;
for (let i = 0; i < count; i++) {
  const converting = performance.now();
  const snapshot = convertSchemas(catalog.entries);
  conversionMs += performance.now() - converting;
  const rendering = performance.now();
  const files = withManifest(
    renderReference(catalog.entries, catalog.tools, snapshot),
    await sourceFingerprint(sourceRoot, snapshot, catalog.tools),
  );
  renderingMs += performance.now() - rendering;
  const checking = performance.now();
  const stale = await checkFiles(root, files);
  fileCheckMs += performance.now() - checking;
  if (stale.length) throw new Error(`Run bun run docs:protocol first: ${stale.join(", ")}`);
}
const elapsed = performance.now() - started;
const fastStart = performance.now();
for (let i = 0; i < count; i++) {
  const snapshot = convertSchemas(catalog.entries);
  const input = await sourceFingerprint(sourceRoot, snapshot, catalog.tools);
  const stale = await checkFingerprint(root, input);
  if (stale.length) throw new Error(`Stale fingerprint: ${stale.join(", ")}`);
}
const fastElapsed = performance.now() - fastStart;
console.log(
  JSON.stringify(
    {
      schemas: catalog.entries.length,
      iterations: count,
      checksPerSecond: Number(((count * 1000) / elapsed).toFixed(2)),
      millisecondsPerCheck: Number((elapsed / count).toFixed(2)),
      fastChecksPerSecond: Number(((count * 1000) / fastElapsed).toFixed(2)),
      millisecondsPerFastCheck: Number((fastElapsed / count).toFixed(2)),
      conversionMs: Number((conversionMs / count).toFixed(2)),
      renderingMs: Number((renderingMs / count).toFixed(2)),
      fileCheckMs: Number((fileCheckMs / count).toFixed(2)),
      peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
    },
    null,
    2,
  ),
);
