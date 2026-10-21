import { expect, test } from "vitest";
import { pack } from "tar-stream";
import { crc32, gzipSync } from "node:zlib";
import { readFile, access, mkdir, stat, truncate, writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractZip } from "./archives.ts";
import { join } from "node:path";
import { registry, temporary, body, sample } from "./testing/support.ts";
import { digest } from "./index.ts";
async function packTar(
  name: string,
  type: "file" | "symlink" = "file",
  following: readonly { name: string; content: string }[] = [],
): Promise<Buffer> {
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
  archive.entry(
    { name, type, ...(type === "symlink" ? { linkname: "../../escape" } : {}) },
    type === "file" ? "synthetic executable" : "",
  );
  for (const entry of following) archive.entry({ name: entry.name, type: "file" }, entry.content);
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}
async function tar(
  name: string,
  type: "file" | "symlink" = "file",
  following: readonly { name: string; content: string }[] = [],
): Promise<Uint8Array> {
  return gzipSync(await packTar(name, type, following));
}
test.each(["traversal", "absolute"])(
  "archive path %s is rejected without publishing or writing outside its private root",
  async (kind) => {
    const work = await temporary();
    const escaped = join(work.root, "escape");
    const name = kind === "traversal" ? "../../../escape" : escaped;
    const bytes = await tar(name);
    const entry = sample();
    entry.distribution.binary = {
      "linux-x86_64": {
        archive: "https://example.org/agent.tgz",
        cmd: "agent",
        args: [],
        env: {},
        sha256: digest(bytes),
      },
    };
    const service = await registry(
      work.root,
      async () => new Response(body([entry])),
      async () => new Response(Buffer.from(bytes)),
    );
    try {
      await service.catalog.refresh();
      const preview = await service.handle({
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      });
      if (!preview.result.ok || !("plan" in preview.result)) throw new Error("No plan");
      const reply = await service.handle({
        type: "registry.install-intent",
        requestId: "install",
        intentId: "intent",
        digest: preview.result.plan.digest,
      });
      expect(reply.result.ok).toBe(false);
      expect(service.inventory.list()).toEqual([]);
      await expect(access(escaped)).rejects.toThrow();
    } finally {
      await service.close();
      await work.close();
    }
  },
);
test("regular tar entries install while symlink artifacts cannot become a launch binding", async () => {
  for (const type of ["file", "symlink"] as const) {
    const work = await temporary();
    const bytes = await tar("agent", type);
    const entry = sample();
    entry.distribution.binary = {
      "linux-x86_64": {
        archive: "https://example.org/agent.tgz",
        cmd: "agent",
        args: [],
        env: {},
        sha256: digest(bytes),
      },
    };
    const service = await registry(
      work.root,
      async () => new Response(body([entry])),
      async () => new Response(Buffer.from(bytes)),
    );
    try {
      await service.catalog.refresh();
      const preview = await service.handle({
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      });
      if (!preview.result.ok || !("plan" in preview.result)) throw new Error("No plan");
      const reply = await service.handle({
        type: "registry.install-intent",
        requestId: "install",
        intentId: "intent",
        digest: preview.result.plan.digest,
      });
      if (type === "file") {
        if (!reply.result.ok || !("installation" in reply.result))
          throw new Error("No installation");
        expect(
          await readFile((await service.resolve(reply.result.installation)).command, "utf8"),
        ).toBe("synthetic executable");
      } else {
        expect(reply.result.ok).toBe(false);
        expect(service.inventory.list()).toEqual([]);
      }
    } finally {
      await service.close();
      await work.close();
    }
  }
});

test("a bzip2 tar installs through the registry and its entrypoint reads back", async () => {
  const work = await temporary();
  try {
    const source = join(work.root, "source.tar");
    await writeFile(source, await packTar("agent"));
    await promisify(execFile)("/usr/bin/bzip2", ["-k", source]);
    const bytes = await readFile(`${source}.bz2`);
    const entry = sample();
    entry.distribution.binary = {
      "linux-x86_64": {
        archive: "https://example.org/agent.tar.bz2",
        cmd: "agent",
        args: [],
        env: {},
        sha256: digest(bytes),
      },
    };
    const service = await registry(
      work.root,
      async () => new Response(body([entry])),
      async () => new Response(Buffer.from(bytes)),
    );
    try {
      await service.catalog.refresh();
      const preview = await service.handle({
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      });
      if (!preview.result.ok || !("plan" in preview.result)) throw new Error("No plan");
      const reply = await service.handle({
        type: "registry.install-intent",
        requestId: "install",
        intentId: "intent",
        digest: preview.result.plan.digest,
      });
      if (!reply.result.ok || !("installation" in reply.result)) throw new Error("No installation");
      expect(
        await readFile((await service.resolve(reply.result.installation)).command, "utf8"),
      ).toBe("synthetic executable");
    } finally {
      await service.close();
    }
  } finally {
    await work.close();
  }
});

test("archive symlinks cannot redirect subsequent entries into an external directory", async () => {
  const work = await temporary();
  // ../../escape is relative to installations/<digest>/files/link.
  const external = join(work.root, "installations", "escape");
  await mkdir(external, { recursive: true });
  const bytes = await tar("link", "symlink", [
    { name: "link/created", content: "escaped" },
    { name: "agent", content: "synthetic executable" },
  ]);
  const entry = sample();
  entry.distribution.binary = {
    "linux-x86_64": {
      archive: "https://example.org/agent.tgz",
      cmd: "agent",
      args: [],
      env: {},
      sha256: digest(bytes),
    },
  };
  const service = await registry(
    work.root,
    async () => new Response(body([entry])),
    async () => new Response(Buffer.from(bytes)),
  );
  try {
    await service.catalog.refresh();
    const preview = await service.handle({
      type: "registry.install-plan",
      requestId: "plan",
      acpAgentId: "official:sample",
      runtime: "binary",
    });
    if (!preview.result.ok || !("plan" in preview.result)) throw new Error("Missing plan");
    const result = await service.handle({
      type: "registry.install-intent",
      requestId: "install",
      intentId: "approved",
      digest: preview.result.plan.digest,
    });
    expect(result.result.ok).toBe(false);
    await expect(access(join(external, "created"))).rejects.toThrow();
    expect(service.inventory.list()).toEqual([]);
  } finally {
    await service.close();
    await work.close();
  }
});

test("a zip with an entry over 256 MiB, as Antigravity's ACP server ships, unpacks in full", async () => {
  const work = await temporary();
  try {
    const source = join(work.root, "source");
    await mkdir(source);
    // 281 MB, the size of agy_acp_server.par in Antigravity 1.4.1; zeros keep the zip small.
    const server = join(source, "agy_acp_server.par");
    await writeFile(server, "");
    await truncate(server, 281_000_000);
    const zip = join(work.root, "server.zip");
    await promisify(execFile)("/usr/bin/zip", ["-q", zip, "agy_acp_server.par"], { cwd: source });
    const root = join(work.root, "installed");
    await mkdir(root);
    await extractZip(zip, root, new AbortController().signal);
    expect((await stat(join(root, "agy_acp_server.par"))).size).toBe(281_000_000);
  } finally {
    await work.close();
  }
}, 60_000);

test("a zip helper marked executable can still run after unpacking, while plain files cannot", async () => {
  const work = await temporary();
  try {
    const source = join(work.root, "source");
    await mkdir(source);
    // Antigravity's ACP server spawns this helper from beside its entrypoint.
    const helper = join(source, "localharness_external");
    await writeFile(helper, "#!/bin/sh\necho helper ran\n");
    await chmod(helper, 0o755);
    await writeFile(join(source, "notes.txt"), "plain data");
    const zip = join(work.root, "server.zip");
    await promisify(execFile)("/usr/bin/zip", ["-q", zip, "localharness_external", "notes.txt"], {
      cwd: source,
    });
    const root = join(work.root, "installed");
    await mkdir(root);
    await extractZip(zip, root, new AbortController().signal);
    const { stdout } = await promisify(execFile)(join(root, "localharness_external"));
    expect(stdout).toBe("helper ran\n");
    expect((await stat(join(root, "localharness_external"))).mode & 0o077).toBe(0);
    expect((await stat(join(root, "notes.txt"))).mode & 0o777).toBe(0o600);
  } finally {
    await work.close();
  }
});

/** A stored (uncompressed) ZIP whose entry names are written as-is, as Windows tools write them. */
function storedZip(files: readonly { name: string; content: string }[]): Buffer {
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
    header.writeUInt16LE(20, 4); // made by MS-DOS, as Windows zips are: no Unix modes
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

test("a Windows-built zip naming entries with backslashes unpacks into its folders", async () => {
  const work = await temporary();
  try {
    // Junie's Windows release names its entries like this.
    const zip = join(work.root, "junie.zip");
    await writeFile(
      zip,
      storedZip([
        { name: "junie\\junie.exe", content: "launcher" },
        { name: "junie\\app\\junie.cfg", content: "config" },
      ]),
    );
    const root = join(work.root, "installed");
    await mkdir(root);
    await extractZip(zip, root, new AbortController().signal);
    expect(await readFile(join(root, "junie", "junie.exe"), "utf8")).toBe("launcher");
    expect(await readFile(join(root, "junie", "app", "junie.cfg"), "utf8")).toBe("config");
  } finally {
    await work.close();
  }
});

test("a backslash zip entry still cannot climb out of the install folder", async () => {
  const work = await temporary();
  try {
    const zip = join(work.root, "escape.zip");
    await writeFile(zip, storedZip([{ name: "..\\..\\escape", content: "outside" }]));
    const root = join(work.root, "installed");
    await mkdir(root);
    await expect(extractZip(zip, root, new AbortController().signal)).rejects.toThrow();
    await expect(access(join(work.root, "escape"))).rejects.toThrow();
  } finally {
    await work.close();
  }
});
