import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { expect, it, onTestFinished } from "vitest";
import { downloadDeviceTools } from "./device-tools.ts";
import type { NpmArtifact } from "./serve-sim-install.ts";
import { managedServeSim } from "./serve-sim-install.ts";
import { serveSimStatus } from "./serve-sim-version.ts";

const run = promisify(execFile);
const runtime = {
  spawn: spawnRawSupervised,
  after(ms: number, callback: () => void) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

const integrity = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** An npm tarball (everything under `package/`) holding `files`. */
async function tarball(root: string, name: string, files: Record<string, string>) {
  const source = join(root, `${name}-source`);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(source, "package", path, ".."), { recursive: true });
    await writeFile(join(source, "package", path), contents);
  }
  const archive = join(root, `${name}.tgz`);
  await run("/usr/bin/tar", ["-czf", archive, "-C", source, "package"]);
  return readFile(archive);
}

/** A registry serving a serve-sim whose script imports `ws` and answers --version. */
async function registry() {
  const root = await mkdtemp(join(tmpdir(), "ace-device-tools-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const serveSim = await tarball(root, "serve-sim", {
    "package.json": JSON.stringify({ name: "serve-sim", version: "0.1.49-beta.139.1", type: "module" }),
    "dist/serve-sim.js": `import { WebSocket } from "ws";\nif (typeof WebSocket === "function" && process.argv.includes("--version")) console.log("0.1.49-beta.139.1");\n`,
  });
  const ws = await tarball(root, "ws", {
    "package.json": JSON.stringify({ name: "ws", version: "8.22.0", main: "index.js" }),
    "index.js": "module.exports = { WebSocket: class WebSocket {} };\n",
  });
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end(request.url === "/serve-sim.tgz" ? serveSim : ws);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${address.port}`;
  const artifacts: { serveSim: NpmArtifact; ws: NpmArtifact } = {
    serveSim: {
      name: "serve-sim",
      version: "0.1.49-beta.139.1",
      url: `${base}/serve-sim.tgz`,
      integrity: integrity(serveSim),
    },
    ws: { name: "ws", version: "8.22.0", url: `${base}/ws.tgz`, integrity: integrity(ws) },
  };
  return { root, artifacts, hits };
}

it("the device tools download puts ace's own serve-sim in its tools folder, run with ace's Node and preferred over PATH", async () => {
  const { root, artifacts, hits } = await registry();
  const directory = join(root, "tools");
  const options = { directory, node: process.execPath, runtime, env: process.env, artifacts };

  const tools = await downloadDeviceTools(options, { serveSim: true, scrcpy: false });
  expect(tools.serveSim).toEqual({
    command: process.execPath,
    args: [join(directory, "serve-sim-0.1.49-beta.139.1", "dist", "serve-sim.js")],
  });
  // The serve-sim ace runs is its own copy, found with no serve-sim on PATH.
  const status = await serveSimStatus(
    { PATH: "" },
    runtime,
    await managedServeSim({ directory, node: process.execPath, artifacts }),
  );
  expect(status).toMatchObject({ version: "0.1.49-beta.139.1", supported: true, source: "ace" });

  // A second download finds the install in place and fetches nothing.
  const before = hits.length;
  await downloadDeviceTools(options, { serveSim: true, scrcpy: false });
  expect(hits.length).toBe(before);
});

it("a package that fails its checksum installs nothing and says why", async () => {
  const { root, artifacts } = await registry();
  const directory = join(root, "tools");
  const tampered = {
    ...artifacts,
    ws: { ...artifacts.ws, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` },
  };
  await expect(
    downloadDeviceTools(
      { directory, node: process.execPath, runtime, env: process.env, artifacts: tampered },
      { serveSim: true, scrcpy: false },
    ),
  ).rejects.toMatchObject({ code: "tool_missing", message: "ws 8.22.0 failed its checksum" });
  expect(
    await managedServeSim({ directory, node: process.execPath, artifacts: tampered }),
  ).toBeUndefined();
});
