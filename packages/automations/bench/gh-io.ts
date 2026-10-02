import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createGhClient } from "../src/index.ts";
const root = mkdtempSync(join(tmpdir(), "ace-gh-io-bench-"));
const binary = join(root, "gh.mjs");
writeFileSync(
  binary,
  `#!/usr/bin/env node\nprocess.stdout.write('HTTP/2 200 OK\\r\\netag: bench\\r\\n\\r\\n'+JSON.stringify([{body:'x'.repeat(65536)}]));\n`,
);
chmodSync(binary, 0o700);
try {
  const client = createGhClient({ binary });
  const start = performance.now();
  for (let i = 0; i < 30; i++) await client.get("repos/owner/repo/issues");
  const elapsed = performance.now() - start;
  console.log(
    `supervised gh process / 64 KiB response: ${(30000 / elapsed).toFixed(0)} ops/s, ${((elapsed / 30) * 1000).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
