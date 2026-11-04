import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { bunVersion, stageBunRuntime } from "./daemon-runtime.ts";

const packageNames = {
  "darwin-arm64": "bun-darwin-aarch64",
  "win32-x64": "bun-windows-x64-baseline",
};

function pinsFor(content: Buffer): { bytes: number; sha256: string } {
  return { bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}

function packagePath(target: keyof typeof packageNames): string {
  const name = packageNames[target];
  return `/@oven/${name}/-/${name}-${bunVersion}.tgz`;
}

/** A tarball shaped like Bun's npm package, holding `binary` under `package/bin`. */
async function bunPackage(root: string, binary: string, content: Buffer): Promise<Buffer> {
  const source = await mkdtemp(join(root, "package-"));
  await mkdir(join(source, "package/bin"), { recursive: true });
  await writeFile(join(source, "package/bin", binary), content);
  await writeFile(join(source, "package/package.json"), "{}");
  const file = join(source, "bun.tgz");
  await create({ gzip: true, file, cwd: source, portable: true }, ["package"]);
  return readFile(file);
}

async function withServer(
  handler: (url: string) => Buffer | undefined,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    const body = request.url ? handler(request.url) : undefined;
    response.statusCode = body ? 200 : 404;
    response.end(body ?? "no fixture");
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

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ace-bun-runtime-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.each([
  ["darwin-arm64", "bun", "bin/node"],
  ["win32-x64", "bun.exe", "node.exe"],
] as const)(
  "%s stages Bun from its pinned package at the runtime's old Node path, with its LICENSE",
  (target, binary, installed) =>
    withRoot(async (root) => {
      const executable = Buffer.from(`fake bun for ${target}`);
      const license = Buffer.from("fake Bun LICENSE");
      const archive = await bunPackage(root, binary, executable);
      await withServer(
        (url) =>
          url === packagePath(target) ? archive : url === "/LICENSE.md" ? license : undefined,
        async (baseUrl) => {
          const runtime = join(root, "runtime");
          await stageBunRuntime({
            target,
            cacheDir: join(root, "cache"),
            executable: join(runtime, installed),
            licensePath: join(runtime, "LICENSE"),
            registry: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE.md`,
            files: { archive: pinsFor(archive), license: pinsFor(license) },
          });
          expect(await readFile(join(runtime, installed))).toEqual(executable);
          expect(await readFile(join(runtime, "LICENSE"))).toEqual(license);
          if (process.platform !== "win32")
            expect((await stat(join(runtime, installed))).mode & 0o777).toBe(0o755);
        },
      );
    }),
);

test("a trusted cache is reused without downloading", () =>
  withRoot(async (root) => {
    const archive = await bunPackage(root, "bun", Buffer.from("cached bun"));
    const license = Buffer.from("cached LICENSE");
    const files = { archive: pinsFor(archive), license: pinsFor(license) };
    const stage = (baseUrl: string, name: string) =>
      stageBunRuntime({
        target: "darwin-arm64",
        cacheDir: join(root, "cache"),
        executable: join(root, name, "bin/node"),
        licensePath: join(root, name, "LICENSE"),
        registry: baseUrl,
        licenseUrl: `${baseUrl}/LICENSE.md`,
        files,
      });
    await withServer(
      (url) =>
        url === packagePath("darwin-arm64") ? archive : url === "/LICENSE.md" ? license : undefined,
      (baseUrl) => stage(baseUrl, "first"),
    );
    // The network is gone: only a verified cache can still stage.
    await withServer(
      () => undefined,
      (baseUrl) => stage(baseUrl, "second"),
    );
    expect(await readFile(join(root, "second/bin/node"))).toEqual(Buffer.from("cached bun"));
  }));

test("a corrupt cache is replaced by a verified download", () =>
  withRoot(async (root) => {
    const archive = await bunPackage(root, "bun", Buffer.from("good bun"));
    const license = Buffer.from("good LICENSE");
    const cacheDir = join(root, "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `bun-darwin-aarch64-${bunVersion}.tgz`), "corrupt archive");
    await writeFile(join(cacheDir, `bun-${bunVersion}-LICENSE.md`), "corrupt license");
    await withServer(
      (url) =>
        url === packagePath("darwin-arm64") ? archive : url === "/LICENSE.md" ? license : undefined,
      (baseUrl) =>
        stageBunRuntime({
          target: "darwin-arm64",
          cacheDir,
          executable: join(root, "runtime/bin/node"),
          licensePath: join(root, "runtime/LICENSE"),
          registry: baseUrl,
          licenseUrl: `${baseUrl}/LICENSE.md`,
          files: { archive: pinsFor(archive), license: pinsFor(license) },
        }),
    );
    expect(await readFile(join(root, "runtime/bin/node"))).toEqual(Buffer.from("good bun"));
    expect(await readFile(join(root, "runtime/LICENSE"))).toEqual(license);
  }));

test.each([
  [
    "a tampered package",
    (archive: Buffer) => {
      // Same length, one byte flipped.
      const tampered = Buffer.from(archive);
      const middle = tampered.length >> 1;
      tampered.writeUInt8(tampered.readUInt8(middle) ^ 0xff, middle);
      return tampered;
    },
    /checksum/i,
  ],
  [
    "an oversized package",
    (archive: Buffer) => Buffer.concat([archive, Buffer.from("extra")]),
    /size exceeded/i,
  ],
] as const)("%s cannot enter the runtime", (_name, serve, refusal) =>
  withRoot(async (root) => {
    const archive = await bunPackage(root, "bun", Buffer.from("good bun"));
    const license = Buffer.from("good LICENSE");
    await withServer(
      (url) =>
        url === packagePath("darwin-arm64")
          ? serve(archive)
          : url === "/LICENSE.md"
            ? license
            : undefined,
      async (baseUrl) => {
        await expect(
          stageBunRuntime({
            target: "darwin-arm64",
            cacheDir: join(root, "cache"),
            executable: join(root, "runtime/bin/node"),
            licensePath: join(root, "runtime/LICENSE"),
            registry: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE.md`,
            files: { archive: pinsFor(archive), license: pinsFor(license) },
          }),
        ).rejects.toThrow(refusal);
      },
    );
    await expect(stat(join(root, "runtime/bin/node"))).rejects.toThrow(/ENOENT/);
  }),
);

test("a package without Bun's binary fails instead of staging an empty runtime", () =>
  withRoot(async (root) => {
    const archive = await bunPackage(root, "not-bun", Buffer.from("other file"));
    const license = Buffer.from("LICENSE");
    await withServer(
      (url) =>
        url === packagePath("darwin-arm64") ? archive : url === "/LICENSE.md" ? license : undefined,
      async (baseUrl) => {
        await expect(
          stageBunRuntime({
            target: "darwin-arm64",
            cacheDir: join(root, "cache"),
            executable: join(root, "runtime/bin/node"),
            licensePath: join(root, "runtime/LICENSE"),
            registry: baseUrl,
            licenseUrl: `${baseUrl}/LICENSE.md`,
            files: { archive: pinsFor(archive), license: pinsFor(license) },
          }),
        ).rejects.toThrow(/has no package\/bin\/bun/);
      },
    );
  }));

test("parallel stagings share the LICENSE cache and each get their own runtime", () =>
  withRoot(async (root) => {
    const mac = await bunPackage(root, "bun", Buffer.from("mac bun"));
    const windows = await bunPackage(root, "bun.exe", Buffer.from("windows bun"));
    const license = Buffer.from("shared LICENSE");
    const cacheDir = join(root, "cache");
    await withServer(
      (url) =>
        url === packagePath("darwin-arm64")
          ? mac
          : url === packagePath("win32-x64")
            ? windows
            : url === "/LICENSE.md"
              ? license
              : undefined,
      async (baseUrl) => {
        const common = { cacheDir, registry: baseUrl, licenseUrl: `${baseUrl}/LICENSE.md` };
        await Promise.all([
          stageBunRuntime({
            ...common,
            target: "darwin-arm64",
            executable: join(root, "mac/bin/node"),
            licensePath: join(root, "mac/LICENSE"),
            files: { archive: pinsFor(mac), license: pinsFor(license) },
          }),
          stageBunRuntime({
            ...common,
            target: "win32-x64",
            executable: join(root, "windows/node.exe"),
            licensePath: join(root, "windows/LICENSE"),
            files: { archive: pinsFor(windows), license: pinsFor(license) },
          }),
        ]);
      },
    );
    expect(await readFile(join(root, "mac/bin/node"))).toEqual(Buffer.from("mac bun"));
    expect(await readFile(join(root, "windows/node.exe"))).toEqual(Buffer.from("windows bun"));
    expect(await readFile(join(root, "windows/LICENSE"))).toEqual(license);
  }));
