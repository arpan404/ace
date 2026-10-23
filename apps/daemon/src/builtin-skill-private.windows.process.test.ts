import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PinnedDirectory } from "@ace/workspace";
import {
  builtinSkillProcessLease,
  builtinSkillRootUnused,
  skillLeaseFilename,
} from "./builtin-skill-processes.ts";

test.runIf(process.platform === "win32")(
  "skill leases publish private evidence and refuse public replacement evidence",
  async ({ onTestFinished }) => {
    const base = await mkdtemp(join(tmpdir(), "ace-skill-private-日本語-"));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "closed");
    const pending = join(base, "pending");
    await mkdir(root);
    await mkdir(pending);
    const lease = builtinSkillProcessLease(root);
    expect(builtinSkillRootUnused(root)).toBe(false);
    lease.close();
    expect(builtinSkillRootUnused(root)).toBe(true);
    const directory = PinnedDirectory.atBoundary(root);
    try {
      expect(directory.readPrivateText(skillLeaseFilename, 32768)).toContain('"closed":true');
      expect(directory.names()).toEqual([skillLeaseFilename]);
    } finally {
      directory.closeSync();
    }
    const unresolved = builtinSkillProcessLease(pending);
    unresolved.preparing();
    unresolved.close();
    expect(builtinSkillRootUnused(pending)).toBe(false);

    // Keep identical valid record bytes but replace the private inode with an
    // ordinary inherited-DACL file. Its contents cannot authorize deletion.
    const file = join(root, skillLeaseFilename);
    const bytes = await readFile(file);
    await rm(file);
    await writeFile(file, bytes);
    expect(builtinSkillRootUnused(root)).toBe(false);
  },
);
