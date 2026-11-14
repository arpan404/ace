/** Root-only or --unsigned-archive runs pre-signing checks. Signed archives require
 * --signed-archive --manifest TARGET.json --public-key KEY.pem. Desktop checks are optional:
 * --desktop APP [--local --screen-identity STAGED.json] [--verify-authenticode].
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { InstalledRelease, DaemonHealth } from "@ace/protocol";
import { checked, runProcess } from "@ace/service";
import { smokeMedia, verifyMediaDesktop } from "./media-smoke.ts";
import { hashFile, verifyManifest, unpackArchive } from "@ace/service";
import { z } from "zod";
import { smokeOptions } from "./smoke-options.ts";
import { ScreenHelperIdentity } from "./screen-identity.ts";
const options = smokeOptions(process.argv.slice(2));
const artifact = resolve(options.root);
const manifest = InstalledRelease.parse(
  JSON.parse(await readFile(join(artifact, "release.json"), "utf8")),
);
if (manifest.target !== `${process.platform}-${process.arch}`)
  throw new Error("Smoke check requires the target host");
// Release mode authenticates the archive before executing any packaged binary.
if (options.manifestPath && options.keyPath) {
  const { manifestPath, keyPath } = options;
  if (!manifestPath || !keyPath)
    throw new Error("Release smoke needs MANIFEST.json PUBLIC_KEY.pem");
  const signed = verifyManifest(
    await readFile(manifestPath),
    (await readFile(manifestPath.replace(/\.json$/, ".sig"), "utf8")).trim(),
    await readFile(keyPath, "utf8"),
  );
  if (signed.target !== manifest.target || signed.version !== manifest.version)
    throw new Error("Signed release does not match smoke target");
  const archive = resolve(manifestPath, "..", signed.archive);
  if ((await hashFile(archive)) !== signed.sha256)
    throw new Error("Signed archive checksum mismatch");
  const extracted = await mkdtemp(join(tmpdir(), "ace-media-signed-"));
  try {
    await unpackArchive(archive, join(extracted, "release"));
    for (const path of [
      "files.json",
      manifest.target.startsWith("win32-") ? "media/ace-media.exe" : "media/ace-media",
    ])
      if (
        (await hashFile(join(extracted, "release", path))) !==
        (await hashFile(join(artifact, path)))
      )
        throw new Error(`Smoke input differs from signed archive: ${path}`);
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}
if (!options.manifestPath)
  process.stdout.write("Unsigned archive smoke: manifest authentication skipped\n");
// files.json is inside the archive authenticated by the release manifest.
const files = z
  .object({ checksums: z.record(z.string(), z.string()) })
  .parse(JSON.parse(await readFile(join(artifact, "files.json"), "utf8")));
const mediaPath = manifest.target.startsWith("win32-") ? "media/ace-media.exe" : "media/ace-media";
if (!files.checksums[mediaPath]) throw new Error("Packaged ace-media checksum is missing");
for (const [path, expected] of Object.entries(files.checksums)) {
  if (
    path.split(/[\\/]/).some((part) => part === "..") ||
    path.startsWith("/") ||
    path.includes(":")
  )
    throw new Error("Unsafe checksum path");
  if (expected !== (await hashFile(join(artifact, path))))
    throw new Error(`Packaged file checksum mismatch: ${path}`);
}
if (process.platform === "win32" && options.authenticode)
  execFileSync("signtool", ["verify", "/pa", join(artifact, mediaPath)], {
    stdio: "inherit",
    timeout: 30_000,
  });
await smokeMedia(
  artifact,
  manifest.target,
  manifest.version,
  join(artifact, "bin", process.platform === "win32" ? "node.exe" : "node"),
);
const app = options.app;
if (app) {
  const resources =
    process.platform === "darwin" ? join(app, "Contents/Resources") : join(app, "resources");
  await verifyMediaDesktop(
    app,
    manifest.target,
    resolve(import.meta.dirname, "../../../native/screen-helper/identity.txt"),
    {
      production: options.production,
      authenticode: options.authenticode,
      ...(options.snapshot
        ? {
            screenIdentity: ScreenHelperIdentity.parse(
              JSON.parse(await readFile(options.snapshot, "utf8")),
            ),
          }
        : {}),
    },
  );
  await smokeMedia(
    resources,
    manifest.target,
    manifest.version,
    join(resources, "runtime", process.platform === "win32" ? "node.exe" : "bin/node"),
  );
}
if (process.platform === "win32") {
  await smokeWindows(artifact, manifest.version);
  process.exit(0);
}
const node = join(artifact, "bin/node");
const pty = await checked(runProcess, node, [
  "-e",
  ptySmoke(["/bin/sh", "-c", "printf ace-pty-smoke"], artifact),
]);
process.stdout.write(pty.stdout);
const root = await mkdtemp(join(tmpdir(), "ace-release-smoke-"));
const child = spawn(node, [join(artifact, "ace.mjs"), "start"], {
  cwd: root,
  env: {
    ...process.env,
    ACE_HOME: root,
    ACE_PORT: "0",
    ACE_LISTEN: "local",
    ACE_MODEL_INSTANCES: "[]",
    ACE_DEV: "0",
    ACE_MAINTENANCE: "0",
    ACE_VERSION: manifest.version,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "",
  errors = "";
child.stderr.on("data", (chunk: Buffer) => {
  if (errors.length < 8192) errors += chunk.toString();
});
try {
  await new Promise<void>((ready, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 8192) output += chunk.toString();
      if (output.includes("Token file:")) ready();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(errors)));
  });
  const endpoint = await readFile(join(root, "daemon-endpoint"), "utf8"),
    token = await readFile(join(root, "daemon-token"), "utf8");
  const response = await fetch(endpoint + "/v1/status", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const health = DaemonHealth.parse(await response.json());
  if (health.version !== manifest.version) throw new Error("Health version mismatch");
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exit;
  if (code !== 0) throw new Error("Daemon did not shut down cleanly");
  process.stdout.write("Daemon and notification worker passed\n");
} finally {
  if (child.exitCode === null) {
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
  }
  await rm(root, { recursive: true, force: true });
}

/**
 * A script for the shipped runtime (Bun) that runs `command` in a terminal the way the daemon's
 * terminals do, through Bun's own PTY, and passes only on its output and a clean exit.
 */
function ptySmoke(command: string[], cwd: string): string {
  return `let output="";const p=Bun.spawn(${JSON.stringify(command)},{cwd:${JSON.stringify(cwd)},terminal:{cols:80,rows:24,data(_t,d){output+=new TextDecoder().decode(d);if(output.length>4096)throw new Error("Unexpected output");}}});p.exited.then(c=>setImmediate(()=>{const ok=c===0&&output.includes("ace-pty-smoke");process.stdout.write(ok?"PTY passed\\n":"PTY failed\\n",()=>process.exit(ok?0:1));}));`;
}

/**
 * The Windows artifact: a ConPTY terminal, then the daemon on an isolated ACE_HOME, stopped
 * the way the service stops it (`POST /v1/stop`; `kill` there is TerminateProcess).
 */
async function smokeWindows(release: string, version: string): Promise<void> {
  const nodeExe = join(release, "bin", "node.exe");
  const terminal = await checked(runProcess, nodeExe, [
    "-e",
    ptySmoke([process.env.ComSpec ?? "cmd.exe", "/d", "/c", "echo ace-pty-smoke"], release),
  ]);
  process.stdout.write(terminal.stdout);
  const home = await mkdtemp(join(tmpdir(), "ace-release-smoke-"));
  const daemon = spawn(nodeExe, [join(release, "ace.mjs"), "start"], {
    cwd: home,
    env: {
      ...process.env,
      ACE_HOME: home,
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_MODEL_INSTANCES: "[]",
      ACE_DEV: "0",
      ACE_MAINTENANCE: "0",
      ACE_VERSION: version,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let daemonOutput = "",
    daemonErrors = "";
  daemon.stderr.on("data", (chunk: Buffer) => {
    if (daemonErrors.length < 8192) daemonErrors += chunk.toString();
  });
  try {
    await new Promise<void>((ready, reject) => {
      daemon.stdout.on("data", (chunk: Buffer) => {
        if (daemonOutput.length < 8192) daemonOutput += chunk.toString();
        if (daemonOutput.includes("Token file:")) ready();
      });
      daemon.once("error", reject);
      daemon.once("exit", () => reject(new Error(daemonErrors)));
    });
    const endpoint = await readFile(join(home, "daemon-endpoint"), "utf8"),
      token = await readFile(join(home, "daemon-token"), "utf8");
    const headers = { authorization: `Bearer ${token}` };
    const response = await fetch(endpoint + "/v1/status", {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const health = DaemonHealth.parse(await response.json());
    if (health.version !== version) throw new Error("Health version mismatch");
    const exit = once(daemon, "exit");
    const stop = await fetch(endpoint + "/v1/stop", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!stop.ok) throw new Error(`Stop request refused: ${stop.status}`);
    const [code] = await exit;
    if (code !== 0) throw new Error(`Daemon did not shut down cleanly (${code}): ${daemonErrors}`);
    process.stdout.write("Daemon and notification worker passed\n");
  } finally {
    if (daemon.exitCode === null) {
      const exit = once(daemon, "exit");
      daemon.kill();
      await exit;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  }
}
