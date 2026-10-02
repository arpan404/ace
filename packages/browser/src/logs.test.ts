import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionLogs } from "./index.ts";

it("bounds log disk usage and preserves accepted grep-able entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-logs-"));
  const logs = new SessionLogs(dir, 512);
  try {
    let accepted = 0;
    for (let i = 0; i < 100; i++)
      if (logs.append("console", { at: i, type: "log", text: `entry-${i}` })) accepted++;
    await logs.flush();
    const data = await readFile(logs.paths.console, "utf8");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(512);
    expect(data).toContain("entry-0");
    expect(data.trim().split("\n")).toHaveLength(accepted);
    expect(accepted).toBeLessThan(100);
  } finally {
    await logs.close();
    await rm(dir, { recursive: true, force: true });
  }
});
