import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { fixture } from "./test-support.ts";

const execute = promisify(execFile);

test.each(["global", "workspace"] as const)(
  "%s settings reject a FIFO without a writer and shutdown completes",
  async (layer) => {
    const f = await fixture();
    try {
      const path = layer === "global" ? f.globalPath : join(f.workspace, ".ace", "settings.json");
      await mkdir(join(path, ".."), { recursive: true });
      await execute("mkfifo", [path]);
      const source = new URL("./index.ts", import.meta.url).href;
      const scope = layer === "global" ? {} : { workspace: f.workspace };
      // A child can be killed if a regression blocks inside the kernel's FIFO open.
      const result = await execute(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { SettingsService } from ${JSON.stringify(source)};
        const service = new SettingsService({ dataDir: ${JSON.stringify(f.dataDir)} });
        const result = await service.read({ keys: ["threads.settleOnClose"], scope: ${JSON.stringify(scope)} });
        await service.close();
        console.log(JSON.stringify(result));
      `,
        ],
        { timeout: 3000 },
      );
      const read = z
        .object({
          entries: z.array(z.object({ value: z.boolean() })),
          diagnostics: z.array(z.object({ code: z.string(), message: z.string() })),
        })
        .parse(JSON.parse(result.stdout));
      expect(read.entries).toEqual([{ value: false }]);
      expect(read.diagnostics).toContainEqual({
        code: "validation",
        message: "Settings file must be a regular file",
      });
    } finally {
      await f.close();
    }
  },
);

test("a regular file replaced at the open boundary is refused before reading the FIFO", async () => {
  const f = await fixture();
  try {
    await f.write(f.globalPath, { "threads.settleOnClose": true });
    const source = new URL("./index.ts", import.meta.url).href;
    const result = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { readBounded } from ${JSON.stringify(source)};
      import { open, unlink, lstat } from "node:fs/promises";
      import { execFile } from "node:child_process";
      import { promisify } from "node:util";
      const path = ${JSON.stringify(f.globalPath)};
      try {
        await readBounded(path, Buffer.alloc, async (...args) => {
          if (!(await lstat(path)).isFile()) throw new Error("Expected original file");
          await unlink(path);
          await promisify(execFile)("mkfifo", [path]);
          return open(...args);
        });
        throw new Error("Accepted FIFO");
      } catch (error) { console.log(error.message); }
    `,
      ],
      { timeout: 3000 },
    );
    expect(result.stdout.trim()).toBe("Settings file must be a regular file");
  } finally {
    await f.close();
  }
});
