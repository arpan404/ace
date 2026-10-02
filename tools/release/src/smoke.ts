import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { InstalledRelease, DaemonHealth } from "@ace/protocol";
import { checked, runProcess } from "@ace/service";
const artifact = resolve(process.argv[2] ?? "");
const manifest = InstalledRelease.parse(
  JSON.parse(await readFile(join(artifact, "release.json"), "utf8")),
);
if (manifest.target !== `${process.platform}-${process.arch}`)
  throw new Error("Smoke check requires the target host");
const node = join(artifact, "bin/node");
const pty = await checked(runProcess, node, [
  "-e",
  `const p=require(${JSON.stringify(join(artifact, "node_modules/node-pty"))});let output="";const t=p.spawn("/bin/sh",["-c","printf ace-pty-smoke"],{name:"xterm",cols:80,rows:24,cwd:${JSON.stringify(artifact)},env:process.env});t.onData(s=>{output+=s;if(output.length>1024)throw new Error("Unexpected output");});t.onExit(e=>{if(e.exitCode!==0||!output.includes("ace-pty-smoke"))process.exitCode=1;else process.stdout.write("PTY passed\\n");});`,
]);
process.stdout.write(pty.stdout);
const root = await mkdtemp(join(tmpdir(), "ace-release-smoke-"));
const child = spawn(node, [join(artifact, "ace.mjs"), "start"], {
  cwd: root,
  env: {
    ...process.env,
    ACE_HOME: root,
    ACE_PORT: "0",
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
