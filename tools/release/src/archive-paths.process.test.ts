import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createReleaseArchive } from "@ace/release";
import { unpackArchive } from "@ace/service";

test.runIf(process.platform === "win32")(
  "nested release files cross the archive boundary on Windows",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ace-archive-paths-"));
    try {
      const source = join(temporary, "source");
      await mkdir(join(source, "runtime", "nested 雪"), { recursive: true });
      await writeFile(join(source, "runtime", "nested 雪", "node.exe"), "runtime fixture");
      const archive = join(temporary, "release.tar.gz");
      await createReleaseArchive(source, archive);
      const destination = join(temporary, "destination");
      await unpackArchive(archive, destination);
      expect(await readFile(join(destination, "runtime", "nested 雪", "node.exe"), "utf8")).toBe(
        "runtime fixture",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
