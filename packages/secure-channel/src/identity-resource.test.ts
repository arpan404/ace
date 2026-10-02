import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";

it("rejecting a sparse oversized identity keeps buffer allocation below 1 MiB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-key-resource-"));
  const file = await open(join(dir, "noise-static.key"), "wx", 0o600);
  try {
    await file.truncate(64 * 1024 * 1024);
  } finally {
    await file.close();
  }
  const entry = new URL("./node.ts", import.meta.url).href;
  // Sample in a separate process so other Vitest tests and their GC cannot affect the budget.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from 'node:assert/strict';
     import { loadOrCreateHostKeys } from ${JSON.stringify(entry)};
     const baseline = process.memoryUsage().arrayBuffers;
     let peak = baseline;
     const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); };
     const timer = setInterval(sample, 1);
     try {
       await assert.rejects(loadOrCreateHostKeys(${JSON.stringify(dir)}), /Invalid stored static key/);
       sample();
     } finally { clearInterval(timer); }
     const allocated = peak - baseline;
     assert.ok(allocated < 1024 * 1024, 'Identity rejection allocated ' + allocated + ' buffer bytes');
     console.log('bounded rejection: ' + allocated + ' buffer bytes');`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = once(child, "close");
  const timeout = setTimeout(() => child.kill(), PROCESS_TEST_TIMEOUT / 2);
  try {
    const [code, signal] = await closed;
    expect(signal).toBeNull();
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("bounded rejection:");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await closed;
    await rm(dir, { recursive: true, force: true });
  }
});
