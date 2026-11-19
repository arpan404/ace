import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { residentSampler, residentSamplingAvailable } from "./resident-memory.ts";

// A real child: what the operating system reports for another process can't be faked. Off
// Linux the sampler needs bun:ffi, so it runs on Bun, as the daemon does.
test.skipIf(!residentSamplingAvailable())(
  "the sampler reads how much memory another process holds, and nothing once it is gone",
  async () => {
    const sample = residentSampler();
    const child = spawn(
      process.execPath,
      [
        "-e",
        // About 80 MB of filled arrays, kept until stdin closes.
        `const keep = []; for (let i = 0; i < 160; i++) keep.push(new Array(1 << 16).fill(i + 0.5));
       process.stdout.write("ready"); process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("The child did not start");
    try {
      await once(child.stdout, "data");
      const before = await sample(process.pid);
      const held = await sample(pid);
      expect(held).toBeGreaterThan(64 * 1024 * 1024);
      // Our own reading is a plain size too, and matches what this runtime reports for itself.
      expect(before).toBeGreaterThan(0);
      expect(Math.abs((before ?? 0) - process.memoryUsage().rss)).toBeLessThan(64 * 1024 * 1024);
    } finally {
      child.stdin.end();
      await once(child, "exit");
    }
    expect(await sample(pid)).toBeUndefined();
  },
);
