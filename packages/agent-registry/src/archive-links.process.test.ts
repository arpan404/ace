import { expect, test } from "vitest";
import { pack } from "tar-stream";
import { crc32, gzipSync } from "node:zlib";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { extractTar, extractZip } from "./archives.ts";
import { createArchiveLinks } from "./archive-links.ts";
import { temporary } from "./testing/support.ts";

type TarEntry = {
  name: string;
  type: "file" | "symlink" | "directory";
  content?: string;
  linkname?: string;
  mode?: number;
};

async function makeTgz(entries: readonly TarEntry[]): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    archive.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected tar bytes");
      chunks.push(chunk);
    });
    archive.once("end", resolve);
    archive.once("error", reject);
  });
  for (const entry of entries) {
    if (entry.type === "symlink")
      archive.entry({ name: entry.name, type: "symlink", linkname: entry.linkname ?? "" }, "");
    else if (entry.type === "directory") archive.entry({ name: entry.name, type: "directory" }, "");
    else
      archive.entry(
        {
          name: entry.name,
          type: "file",
          ...(entry.mode === undefined ? {} : { mode: entry.mode }),
        },
        entry.content ?? "",
      );
  }
  archive.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

test("a tar like Harn's installs its harn-dap link beside harn", async () => {
  const work = await temporary();
  try {
    const bytes = await makeTgz([
      { name: "harn", type: "file", content: "#!/bin/sh\necho harn ran\n", mode: 0o755 },
      { name: "harn-dap", type: "symlink", linkname: "harn" },
    ]);
    const archive = join(work.root, "harn.tgz");
    await writeFile(archive, bytes);
    const root = join(work.root, "installed");
    await mkdir(root);
    await extractTar(archive, root, new AbortController().signal);
    expect(await readlink(join(root, "harn-dap"))).toBe("harn");
    expect(await readFile(join(root, "harn-dap"), "utf8")).toBe("#!/bin/sh\necho harn ran\n");
    const { stdout } = await promisify(execFile)(join(root, "harn-dap"));
    expect(stdout).toBe("harn ran\n");
  } finally {
    await work.close();
  }
});

test("a link chain escape is refused and nothing is written outside the root", async () => {
  const work = await temporary();
  try {
    const bytes = await makeTgz([
      { name: "a", type: "symlink", linkname: "." },
      { name: "a/l", type: "symlink", linkname: "../q" },
    ]);
    const archive = join(work.root, "chain.tgz");
    await writeFile(archive, bytes);
    const root = join(work.root, "installed");
    await mkdir(root);
    await expect(extractTar(archive, root, new AbortController().signal)).rejects.toThrow();
    await expect(access(join(work.root, "q"))).rejects.toThrow();
    await expect(access(join(root, "q"))).rejects.toThrow();
  } finally {
    await work.close();
  }
});

type ZipEntry = {
  name: string;
  content: string;
  symlink?: boolean;
};

function storedZip(files: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    if (file.symlink) {
      header.writeUInt16LE((3 << 8) | 20, 4);
      header.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    } else {
      header.writeUInt16LE(20, 4);
    }
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("a zip symlink entry is created as a link", async () => {
  const work = await temporary();
  try {
    const zip = join(work.root, "links.zip");
    await writeFile(
      zip,
      storedZip([
        { name: "target.txt", content: "linked data" },
        { name: "link.txt", content: "target.txt", symlink: true },
      ]),
    );
    const root = join(work.root, "installed");
    await mkdir(root);
    await extractZip(zip, root, new AbortController().signal);
    expect((await lstat(join(root, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, "link.txt"))).toBe("target.txt");
    expect(await readFile(join(root, "link.txt"), "utf8")).toBe("linked data");
  } finally {
    await work.close();
  }
});

test("a mkdir through an earlier link cannot create a directory outside the root", async () => {
  const work = await temporary();
  try {
    const bytes = await makeTgz([
      { name: "d", type: "symlink", linkname: "s/.." },
      { name: "s", type: "symlink", linkname: "." },
      { name: "d/x/l", type: "symlink", linkname: "." },
    ]);
    const archive = join(work.root, "mkdir-escape.tgz");
    await writeFile(archive, bytes);
    const root = join(work.root, "installed");
    await mkdir(root);
    await expect(extractTar(archive, root, new AbortController().signal)).rejects.toThrow();
    await expect(access(join(work.root, "x"))).rejects.toThrow();
  } finally {
    await work.close();
  }
});

test("a tar with an absolute venv interpreter link installs and keeps its target", async () => {
  const work = await temporary();
  try {
    const bytes = await makeTgz([
      { name: "agent", type: "file", content: "synthetic executable" },
      { name: "bin/python3.12", type: "symlink", linkname: "/usr/bin/python3.12" },
    ]);
    const archive = join(work.root, "absolute.tgz");
    await writeFile(archive, bytes);
    const root = join(work.root, "installed");
    await mkdir(root);
    await extractTar(archive, root, new AbortController().signal);
    expect(await readlink(join(root, "bin", "python3.12"))).toBe("/usr/bin/python3.12");
    expect(await readFile(join(root, "agent"), "utf8")).toBe("synthetic executable");
  } finally {
    await work.close();
  }
});

test("the Windows EPERM fallback skips absolute and still-missing targets", async () => {
  const work = await temporary();
  try {
    const root = join(work.root, "installed");
    await mkdir(root);
    await writeFile(join(root, "real.txt"), "file data");
    await createArchiveLinks(
      root,
      [
        { linkPath: join(root, "abs"), target: "/usr/bin/python3.12" },
        { linkPath: join(root, "missing"), target: "nope/missing" },
        { linkPath: join(root, "ok"), target: "real.txt" },
      ],
      failingSymlink,
    );
    await expect(access(join(root, "abs"))).rejects.toThrow();
    await expect(access(join(root, "missing"))).rejects.toThrow();
    expect(await readFile(join(root, "ok"), "utf8")).toBe("file data");
  } finally {
    await work.close();
  }
});
async function failingSymlink(target: string, path: string, type?: "junction"): Promise<void> {
  if (type !== "junction") throw Object.assign(new Error("symlink EPERM"), { code: "EPERM" });
  await symlink(target, path, "junction");
}

test("the Windows EPERM fallback produces a junction or copy", async () => {
  const work = await temporary();
  try {
    const root = join(work.root, "installed");
    await mkdir(root);
    await writeFile(join(root, "real.txt"), "file data");
    await mkdir(join(root, "realdir"));
    await writeFile(join(root, "realdir", "inner.txt"), "inner data");
    await createArchiveLinks(
      root,
      [
        { linkPath: join(root, "middle"), target: "real.txt" },
        { linkPath: join(root, "outer"), target: "middle" },
        { linkPath: join(root, "linkdir"), target: "realdir" },
      ],
      failingSymlink,
    );
    expect((await lstat(join(root, "middle"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(root, "middle"), "utf8")).toBe("file data");
    expect(await readFile(join(root, "outer"), "utf8")).toBe("file data");
    expect(await readFile(join(root, "linkdir", "inner.txt"), "utf8")).toBe("inner data");
    expect((await stat(join(root, "linkdir"))).isDirectory()).toBe(true);
  } finally {
    await work.close();
  }
});
