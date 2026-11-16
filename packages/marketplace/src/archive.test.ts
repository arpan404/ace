import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPackage } from "@ace/plugins";
import { ArchiveError, readArchive, writeArchive } from "./archive.ts";
import { contentHash, hashFiles } from "./hash.ts";
import { typeLimits } from "./limits.ts";
import { folder } from "./testing.ts";

const limits = typeLimits["spade-skill"];

/** A raw tar header block for hand-made archives a publisher's own tool might write. */
function header(name: string, type: string, size = 0, mode = 0o644): Uint8Array {
  const block = new Uint8Array(512);
  const put = (offset: number, value: string) => block.set(new TextEncoder().encode(value), offset);
  put(0, name);
  put(100, mode.toString(8).padStart(7, "0"));
  put(124, size.toString(8).padStart(11, "0"));
  block[156] = type.charCodeAt(0);
  put(257, "ustar");
  let sum = 0;
  for (let index = 0; index < 512; index++)
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}
const join2 = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 1024));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

describe("entry archives", () => {
  it("read back the files they were written from, executable bits included", () => {
    const files = folder({
      "SKILL.md": "# Hi\n",
      "scripts/run.sh*": "#!/bin/sh\n",
      "a/b/c.txt": "deep",
    });
    const read = readArchive(writeArchive(files), limits);
    expect(
      read.map((file) => [file.path, file.executable, new TextDecoder().decode(file.content)]),
    ).toEqual([
      ["SKILL.md", false, "# Hi\n"],
      ["a/b/c.txt", false, "deep"],
      ["scripts/run.sh", true, "#!/bin/sh\n"],
    ]);
  });

  it("are the same bytes for the same files in any order", () => {
    const files = folder({ "b.md": "b", "a.md": "a" });
    expect(writeArchive(files)).toEqual(writeArchive(files.toReversed()));
  });

  it("carry paths longer than a tar name field", () => {
    const path = `${"long-folder-name/".repeat(8)}SKILL.md`;
    const [file] = readArchive(writeArchive(folder({ [path]: "x" })), typeLimits["spade-plugin"]);
    expect(file?.path).toBe(path);
  });

  it.each([
    ["a symbolic link", header("link", "2")],
    ["a hard link", header("link", "1")],
    ["a device", header("dev", "3")],
    ["a path out of the folder", header("../escape.md", "0")],
    ["an absolute path", header("/etc/passwd", "0")],
    ["a .git folder", header(".git/config", "0")],
  ])("refuse %s", (_label, block) => {
    expect(() => readArchive(join2(block), limits)).toThrow(ArchiveError);
  });

  it("refuse a file listed twice", () => {
    const content = new Uint8Array(512);
    expect(() =>
      readArchive(join2(header("a.md", "0", 1), content, header("a.md", "0", 1), content), limits),
    ).toThrow(/twice/);
  });

  it("refuse more bytes than the type allows", () => {
    const big = new Uint8Array(limits.fileBytes + 1);
    expect(() =>
      readArchive(writeArchive([{ path: "big.bin", executable: false, content: big }]), limits),
    ).toThrow(/limit/);
  });

  it("hash to the plugin manager's content hash for the same folder", async () => {
    const files = folder({
      "ace-plugin.json": "{}",
      "bin/tool*": "#!/bin/sh\n",
      "skills/x/SKILL.md": "x",
    });
    const root = await mkdtemp(join(await realpath(tmpdir()), "market-hash-"));
    try {
      for (const file of files) {
        await mkdir(dirname(join(root, file.path)), { recursive: true });
        await writeFile(join(root, file.path), file.content, {
          mode: file.executable ? 0o755 : 0o644,
        });
      }
      expect(contentHash(hashFiles(files))).toBe((await inspectPackage(root)).hash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("with a malformed extended header", () => {
    const record = (key: string, value: string) => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      while (length !== body.length + String(length).length)
        length = body.length + String(length).length;
      return `${length}${body}`;
    };
    /** A pax header saying `text`, then a regular file holding `content`. */
    const paxed = (text: string, content = "hello") => {
      const pax = new TextEncoder().encode(text);
      const paxBlock = new Uint8Array(Math.ceil(pax.byteLength / 512) * 512);
      paxBlock.set(pax);
      const file = new Uint8Array(512);
      file.set(new TextEncoder().encode(content));
      return join2(
        header("././@PaxHeader", "x", pax.byteLength),
        paxBlock,
        header("a.md", "0", 5),
        file,
      );
    };

    it.each([
      ["a negative size", record("size", "-1024")],
      ["a fractional size", record("size", "12.5")],
      ["a size past the safe integers", record("size", "9007199254740993")],
      ["a size that isn't a number", record("size", "lots")],
      ["a size past the archive's end", record("size", "4096")],
      ["a record longer than what is left", "900 path=a.md\n"],
      ["a record whose length isn't a number", "x path=a.md\n"],
    ])("refuses %s promptly", { timeout: 2_000 }, (_label, text) => {
      expect(() => readArchive(paxed(text), limits)).toThrow(ArchiveError);
    });

    it(
      "refuses a negative size that would step back onto an earlier header",
      { timeout: 2_000 },
      () => {
        // Each header says the next one is 1536 bytes long, which steps the reader back to the first.
        const pax = new TextEncoder().encode(record("size", "-1536"));
        const paxBlock = new Uint8Array(512);
        paxBlock.set(pax);
        const looping = join2(
          header("././@PaxHeader", "x", pax.byteLength),
          paxBlock,
          header("././@PaxHeader", "x", pax.byteLength),
          paxBlock,
        );
        expect(() => readArchive(looping, limits)).toThrow(ArchiveError);
      },
    );

    it("still reads a well-formed one", () => {
      const [file] = readArchive(paxed(record("path", "long/name.md")), limits);
      expect(file?.path).toBe("long/name.md");
    });
  });
});
