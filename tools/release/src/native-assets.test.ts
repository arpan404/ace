import { expect, test } from "vitest";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stageNativeFiles } from "@ace/release";

test.each(["linux-x64", "linux-arm64"])(
  "%s staging packages the checked PTY without requiring a macOS spawn helper",
  async (target) => {
    const root = await mkdtemp(join(tmpdir(), "ace-native-"));
    try {
      const pty = join(root, "input.node");
      const payload = Buffer.from("owned native fixture");
      await writeFile(pty, payload);
      const destination = join(root, "artifact");
      await stageNativeFiles(target, join(root, "absent-prebuild"), destination, {
        pty,
        ptySha256: createHash("sha256").update(payload).digest("hex"),
      });
      expect(await readFile(join(destination, "pty.node"))).toEqual(payload);
      expect(await readdir(destination)).toEqual(["pty.node"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("a corrupt Linux native input cannot enter the artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-native-"));
  try {
    const pty = join(root, "input.node");
    await writeFile(pty, "corrupt native fixture");
    const destination = join(root, "artifact");
    await expect(
      stageNativeFiles("linux-x64", root, destination, {
        pty,
        ptySha256: "0".repeat(64),
      }),
    ).rejects.toThrow("checksum");
    expect(await readdir(destination)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
