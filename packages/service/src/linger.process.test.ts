import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "vitest";
import { enableLinger } from "./index.ts";
const execute = promisify(execFile);
test("linger targets only the invoking user's numeric identity and refuses unsupported platforms", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-linger-"));
  const marker = join(home, "linger");
  try {
    const binary = join(home, "loginctl");
    await writeFile(
      binary,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},process.argv.slice(2).join(' '));`,
      { mode: 0o700 },
    );
    const run = async (file: string, args: readonly string[]) => {
      const result = await execute(file === "loginctl" ? binary : file, [...args]);
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    };
    await enableLinger("linux", 1000, run);
    expect(await readFile(marker, "utf8")).toBe("enable-linger 1000");
    await expect(enableLinger("darwin", 1000, run)).rejects.toThrow("Linux");
    await expect(enableLinger("linux", -1, run)).rejects.toThrow();
    expect(await readFile(marker, "utf8")).toBe("enable-linger 1000");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
