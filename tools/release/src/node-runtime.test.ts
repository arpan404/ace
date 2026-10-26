import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeVersion, stageWindowsNodeRuntime } from "./node-runtime.ts";

const names = {
  exe: `node-v${nodeVersion}-win32-x64.exe`,
  license: `node-v${nodeVersion}-LICENSE`,
};

function pinsFor(content: Buffer): { bytes: number; sha256: string } {
  return {
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function withServer(
  handler: (url: string) => { status: number; body: Buffer } | undefined,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    const served = request.url ? handler(request.url) : undefined;
    if (!served) {
      response.statusCode = 404;
      response.end("no fixture");
      return;
    }
    response.statusCode = served.status;
    response.end(served.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test.each(["win32-x64", "win32-arm64"] as const)(
  "%s stages node.exe and LICENSE from the network into the runtime layout",
  async (target) => {
    const root = await mkdtemp(join(tmpdir(), "ace-win-node-"));
    try {
      const distPath = target === "win32-x64" ? "win-x64/node.exe" : "win-arm64/node.exe";
      const exe = Buffer.from(`fake node.exe for ${target}`);
      const license = Buffer.from(`fake LICENSE for ${target}`);
      await withServer(
        (url) => {
          if (url === `/${distPath}`) return { status: 200, body: exe };
          if (url === "/LICENSE") return { status: 200, body: license };
          return undefined;
        },
        async (baseUrl) => {
          const cacheDir = join(root, "cache");
          const destination = join(root, "runtime");
          await mkdir(cacheDir, { recursive: true });
          await stageWindowsNodeRuntime({
            target,
            cacheDir,
            destination,
            distBaseUrl: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE`,
            files: { exe: pinsFor(exe), license: pinsFor(license) },
          });
          expect(await readFile(join(destination, "node.exe"))).toEqual(exe);
          expect(await readFile(join(destination, "LICENSE"))).toEqual(license);
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a trusted cache is reused without downloading", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-win-node-"));
  try {
    const exe = Buffer.from("cached fake node.exe");
    const license = Buffer.from("cached fake LICENSE");
    const files = { exe: pinsFor(exe), license: pinsFor(license) };
    const cacheDir = join(root, "cache");
    await mkdir(cacheDir, { recursive: true });
    await withServer(
      (url) => {
        if (url === "/win-x64/node.exe") return { status: 200, body: exe };
        if (url === "/LICENSE") return { status: 200, body: license };
        return undefined;
      },
      async (baseUrl) => {
        await stageWindowsNodeRuntime({
          target: "win32-x64",
          cacheDir,
          destination: join(root, "first"),
          distBaseUrl: baseUrl,
          licenseUrl: `${baseUrl}/LICENSE`,
          files,
        });
      },
    );
    // The network is gone: only a verified cache can still stage.
    await withServer(
      () => ({ status: 500, body: Buffer.from("must not be fetched") }),
      async (baseUrl) => {
        const destination = join(root, "second");
        await stageWindowsNodeRuntime({
          target: "win32-x64",
          cacheDir,
          destination,
          distBaseUrl: baseUrl,
          licenseUrl: `${baseUrl}/LICENSE`,
          files,
        });
        expect(await readFile(join(destination, "node.exe"))).toEqual(exe);
        expect(await readFile(join(destination, "LICENSE"))).toEqual(license);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt cache is replaced by a verified download", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-win-node-"));
  try {
    const exe = Buffer.from("good fake node.exe");
    const license = Buffer.from("good fake LICENSE");
    const files = { exe: pinsFor(exe), license: pinsFor(license) };
    const cacheDir = join(root, "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, names.exe), "corrupt exe");
    await writeFile(join(cacheDir, names.license), "corrupt license");
    await withServer(
      (url) => {
        if (url === "/win-x64/node.exe") return { status: 200, body: exe };
        if (url === "/LICENSE") return { status: 200, body: license };
        return undefined;
      },
      async (baseUrl) => {
        const destination = join(root, "runtime");
        await stageWindowsNodeRuntime({
          target: "win32-x64",
          cacheDir,
          destination,
          distBaseUrl: baseUrl,
          licenseUrl: `${baseUrl}/LICENSE`,
          files,
        });
        expect(await readFile(join(destination, "node.exe"))).toEqual(exe);
        expect(await readFile(join(destination, "LICENSE"))).toEqual(license);
        expect(await readFile(join(cacheDir, names.exe))).toEqual(exe);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a checksum mismatch cannot enter the runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-win-node-"));
  try {
    const exe = Buffer.from("good fake node.exe");
    const license = Buffer.from("good fake LICENSE");
    const files = { exe: pinsFor(exe), license: pinsFor(license) };
    await withServer(
      (url) => {
        if (url === "/win-x64/node.exe") return { status: 200, body: Buffer.from("tampered exe") };
        if (url === "/LICENSE") return { status: 200, body: license };
        return undefined;
      },
      async (baseUrl) => {
        await expect(
          stageWindowsNodeRuntime({
            target: "win32-x64",
            cacheDir: join(root, "cache"),
            destination: join(root, "runtime"),
            distBaseUrl: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE`,
            files,
          }),
        ).rejects.toThrow(/checksum|size|download/i);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized download is refused before it can grow the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-win-node-"));
  try {
    const exe = Buffer.from("ab");
    const license = Buffer.from("c");
    const files = { exe: pinsFor(exe), license: pinsFor(license) };
    await withServer(
      (url) => {
        if (url === "/win-x64/node.exe") return { status: 200, body: Buffer.from("abcd") };
        if (url === "/LICENSE") return { status: 200, body: license };
        return undefined;
      },
      async (baseUrl) => {
        await expect(
          stageWindowsNodeRuntime({
            target: "win32-x64",
            cacheDir: join(root, "cache"),
            destination: join(root, "runtime"),
            distBaseUrl: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE`,
            files,
          }),
        ).rejects.toThrow(/size exceeded|checksum/i);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel staging shares the LICENSE cache without losing either runtime", async () => {
  // The LICENSE cache entry is shared across architectures, so two stagings race on
  // it. Both must still produce their own verified runtime from observable files.
  const root = await mkdtemp(join(tmpdir(), "ace-win-node-"));
  try {
    const exeX64 = Buffer.from("parallel fake node.exe x64");
    const exeArm64 = Buffer.from("parallel fake node.exe arm64");
    const license = Buffer.from("parallel fake LICENSE");
    const cacheDir = join(root, "cache");
    await withServer(
      (url) => {
        if (url === "/win-x64/node.exe") return { status: 200, body: exeX64 };
        if (url === "/win-arm64/node.exe") return { status: 200, body: exeArm64 };
        if (url === "/LICENSE") return { status: 200, body: license };
        return undefined;
      },
      async (baseUrl) => {
        await Promise.all([
          stageWindowsNodeRuntime({
            target: "win32-x64",
            cacheDir,
            destination: join(root, "runtime-x64"),
            distBaseUrl: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE`,
            files: { exe: pinsFor(exeX64), license: pinsFor(license) },
          }),
          stageWindowsNodeRuntime({
            target: "win32-arm64",
            cacheDir,
            destination: join(root, "runtime-arm64"),
            distBaseUrl: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE`,
            files: { exe: pinsFor(exeArm64), license: pinsFor(license) },
          }),
        ]);
      },
    );
    expect(await readFile(join(root, "runtime-x64", "node.exe"))).toEqual(exeX64);
    expect(await readFile(join(root, "runtime-x64", "LICENSE"))).toEqual(license);
    expect(await readFile(join(root, "runtime-arm64", "node.exe"))).toEqual(exeArm64);
    expect(await readFile(join(root, "runtime-arm64", "LICENSE"))).toEqual(license);
    expect(await readdir(cacheDir)).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed download leaves no cache entry and the next staging retries", async () => {
  // A 500 must not leave a partial cache file behind: the retry serves the same URLs
  // and must stage both files from observable outputs.
  const root = await mkdtemp(join(tmpdir(), "ace-win-node-"));
  try {
    const exe = Buffer.from("retry fake node.exe");
    const license = Buffer.from("retry fake LICENSE");
    const files = { exe: pinsFor(exe), license: pinsFor(license) };
    const cacheDir = join(root, "cache");
    await withServer(
      (url) => {
        if (url === "/win-x64/node.exe") return { status: 500, body: Buffer.from("boom") };
        if (url === "/LICENSE") return { status: 200, body: license };
        return undefined;
      },
      async (baseUrl) => {
        await expect(
          stageWindowsNodeRuntime({
            target: "win32-x64",
            cacheDir,
            destination: join(root, "failed"),
            distBaseUrl: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE`,
            files,
          }),
        ).rejects.toThrow(/download failed|checksum|size/i);
      },
    );
    const entries = await readdir(cacheDir).catch(() => []);
    expect(entries).not.toContain(names.exe);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await withServer(
      (url) => {
        if (url === "/win-x64/node.exe") return { status: 200, body: exe };
        if (url === "/LICENSE") return { status: 200, body: license };
        return undefined;
      },
      async (baseUrl) => {
        const destination = join(root, "runtime");
        await stageWindowsNodeRuntime({
          target: "win32-x64",
          cacheDir,
          destination,
          distBaseUrl: baseUrl,
          licenseUrl: `${baseUrl}/LICENSE`,
          files,
        });
        expect(await readFile(join(destination, "node.exe"))).toEqual(exe);
        expect(await readFile(join(destination, "LICENSE"))).toEqual(license);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
