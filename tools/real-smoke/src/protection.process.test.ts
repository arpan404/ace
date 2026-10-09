import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { readOnlyProfile } from "./processes.ts";
const execute = promisify(execFile);
test.skipIf(process.platform !== "darwin")(
  "filesystem protection refuses source and project reads and owner writes while scratch remains writable",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-smoke-protection-")));
    const scratch = join(root, "scratch"),
      source = join(root, "source"),
      project = join(root, "project");
    try {
      for (const path of [scratch, source, project]) await mkdir(path);
      await writeFile(join(source, "daemon-token"), "never read");
      await writeFile(join(project, "README.md"), "never read");
      const program = `import { readFileSync, writeFileSync } from 'node:fs';
      const refused = [];
      for (const path of process.argv.slice(1, 3)) { try { readFileSync(path); } catch { refused.push('read'); } }
      try { writeFileSync(process.argv[3], 'unsafe'); } catch { refused.push('write'); }
      writeFileSync(process.argv[4], 'scratch');
      process.stdout.write(JSON.stringify(refused));`;
      const result = await execute("/usr/bin/sandbox-exec", [
        "-p",
        readOnlyProfile(scratch, source, [project], "/unused-checkout"),
        process.execPath,
        "--input-type=module",
        "-e",
        program,
        join(source, "daemon-token"),
        join(project, "README.md"),
        join(project, "new.txt"),
        join(scratch, "allowed.txt"),
      ]);
      expect(JSON.parse(result.stdout)).toEqual(["read", "read", "write"]);
      expect(await readFile(join(scratch, "allowed.txt"), "utf8")).toBe("scratch");
      expect(await readFile(join(project, "README.md"), "utf8")).toBe("never read");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
