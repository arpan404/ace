import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants, existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { atomicPointer, prepareDaemonHome } from "@ace/service";
import { scriptRuntimeName, shippedExecutableName } from "@ace/service/process-names";

const startTimeoutMs = 60_000;
const LockOwner = z.object({ pid: z.number().int().positive() });
const RuntimeRecord = z.object({
  message: z.literal("The daemon's runtime"),
  data: z.object({ daemon: z.string(), scripts: z.string(), cwd: z.string() }),
});

/**
 * The daemon as an installed release starts it: `ace supervise` from
 * `<home>/releases/<release>/`, in an empty home, from a working directory whose `.env` would
 * silence the daemon's log and whose `bunfig.toml` would run a preload that leaves a mark. Run
 * twice: as the release starts it (on the runtime's `ace Service` link, the same file as
 * `bin/node`) and with that name blocked by a folder, so it falls back to `bin/node`. Either way
 * the daemon must run in the release's own folder, read neither file, and report that its
 * child scripts run on `bin/node`.
 */
export async function smokeNamedDaemon(artifact: string, version: string, target: string) {
  await smokeSupervisedDaemon(artifact, version, target, "named");
  await smokeSupervisedDaemon(artifact, version, target, "plain");
}

async function smokeSupervisedDaemon(
  artifact: string,
  version: string,
  target: string,
  expected: "named" | "plain",
) {
  const root = await mkdtemp(join(tmpdir(), "ace-named-smoke-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const mark = join(root, "preload-ran");
  const name = `${version}-${target}`;
  const release = join(home, "releases", name);
  let supervisor: ChildProcess | undefined;
  let daemon: number | undefined;
  try {
    // As `ace install-artifact` lays it out: a home of this format first, else the daemon moves
    // the folder aside as an older ace's.
    prepareDaemonHome(home);
    // A clone where the file system has them, so the smoke copies no runtime bytes.
    await cp(artifact, release, { recursive: true, mode: constants.COPYFILE_FICLONE });
    await atomicPointer(join(home, "current"), `releases/${name}`);
    await mkdir(project);
    await writeFile(join(project, ".env"), "ACE_LOG_LEVEL=silent\n");
    await writeFile(join(project, "bunfig.toml"), 'preload = ["./preload.mjs"]\n');
    await writeFile(
      join(project, "preload.mjs"),
      `require("node:fs").appendFileSync(${JSON.stringify(mark)}, process.argv.join(" ") + "\\n");\n`,
    );
    const runtime = join(release, "bin", scriptRuntimeName(process.platform));
    const named = join(release, "bin", shippedExecutableName("daemon", process.platform));
    // A folder under the daemon's name is never replaced: the start falls back to bin/node.
    if (expected === "plain") await mkdir(named);
    supervisor = spawn(runtime, [join(release, "ace.mjs"), "supervise"], {
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {}),
        HOME: root,
        USERPROFILE: root,
        ACE_HOME: home,
        ACE_PORT: "0",
        ACE_LISTEN: "local",
        ACE_MODEL_INSTANCES: "[]",
        ACE_DEV: "0",
      },
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = await daemonPid(home, supervisor.pid);
    daemon = pid;
    const executable = executableOf(pid);
    const wanted = expected === "named" ? named : runtime;
    if (basename(executable) !== basename(wanted))
      throw new Error(`The supervised daemon runs as ${executable}, not ${wanted}`);
    if (!sameFile(executable, runtime))
      throw new Error(`${executable} is not the release's runtime ${runtime}`);
    const record = await runtimeRecord(home);
    // The log redacts the home and version in paths, so the file names are what it can show.
    if (
      basename(record.daemon) !== basename(wanted) ||
      basename(record.scripts) !== basename(runtime)
    )
      throw new Error(`The daemon gives its scripts ${record.scripts}, not ${runtime}`);
    // Its working directory is the release's folder, never the one the service started in.
    const cwd = workingDirectoryOf(pid) ?? record.cwd;
    if (process.platform === "win32" ? !record.cwd.endsWith(`-${target}`) : !sameFile(cwd, release))
      throw new Error(`The supervised daemon runs in ${cwd}, not ${release}`);
    // The supervisor itself runs in the project, so a mark there could only be its own.
    const preload = existsSync(mark) ? readFileSync(mark, "utf8") : "";
    if (preload.includes(join(release, "ace.mjs") + " start"))
      throw new Error(`The daemon ran the bunfig.toml preload of ${project}`);
    process.stdout.write(
      `Supervised daemon (${expected}) runs as ${basename(wanted)} in its release, scripts on node\n`,
    );
  } finally {
    if (supervisor) await stop(supervisor);
    if (daemon !== undefined) await gone(daemon);
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

/** The process's working directory, where the OS tells it (not Windows). */
function workingDirectoryOf(pid: number): string | undefined {
  if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
  if (process.platform !== "darwin") return undefined;
  const listing = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  return listing
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}

/** The pid in the home's `daemon-lock` once a process other than the supervisor holds it. */
async function daemonPid(home: string, supervisor: number | undefined): Promise<number> {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const { pid } = LockOwner.parse(JSON.parse(readFileSync(join(home, "daemon-lock"), "utf8")));
      if (pid !== supervisor && existsSync(join(home, "daemon-endpoint"))) return pid;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The supervisor started no daemon: ${await errors(home)}`);
}

/** The file the process runs: the name it was started under, links included. */
function executableOf(pid: number): string {
  if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`);
  if (process.platform === "win32")
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
  return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

function sameFile(a: string, b: string): boolean {
  const [left, right] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
  return left.dev === right.dev && left.ino === right.ino;
}

/** The daemon's record of its runtime and its scripts', from `logs/ace.jsonl`. */
async function runtimeRecord(
  home: string,
): Promise<{ daemon: string; scripts: string; cwd: string }> {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    const lines = await readFile(join(home, "logs", "ace.jsonl"), "utf8").catch(() => "");
    for (const line of lines.split("\n")) {
      if (!line.includes("The daemon's runtime")) continue;
      const parsed = RuntimeRecord.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The daemon logged no runtime record (a .env it read silences it)`);
}

async function errors(home: string): Promise<string> {
  const read = (file: string) =>
    readFile(join(home, "logs", file), "utf8").then(
      (text) => text.slice(-2048),
      () => "",
    );
  return `${await read("daemon.err.log")}${await read("error.log")}`;
}

/** Stops the supervisor, which stops its daemon; Windows has no SIGTERM, so its tree ends. */
async function stop(supervisor: ChildProcess): Promise<void> {
  if (supervisor.exitCode !== null || supervisor.pid === undefined) return;
  const exit = once(supervisor, "exit");
  if (process.platform === "win32")
    execFileSync("taskkill.exe", ["/T", "/F", "/PID", String(supervisor.pid)], {
      stdio: "ignore",
    });
  else supervisor.kill("SIGTERM");
  const timer = setTimeout(() => supervisor.kill("SIGKILL"), 30_000);
  await exit;
  clearTimeout(timer);
}

/** The supervisor stops its daemon before it exits; one left running fails the smoke. */
async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  process.kill(pid, "SIGKILL");
  throw new Error(`The supervised daemon ${pid} outlived its supervisor`);
}
