import { join, win32 } from "node:path";
import type { UserPathRegistry } from "./user-path.ts";
import { addToUserPath, removeFromUserPath } from "./user-path.ts";

/**
 * What the Windows installer and uninstaller do beyond copying files, run by them on the
 * app's own bundled Node (`resources\setup\ace-setup.mjs`, see `build/installer.nsh`):
 *
 * - `install`: write the `ace` command (`<home>\bin\ace.cmd`) and, on a fresh install, put
 *   its folder on the user PATH. An update leaves PATH as the person set it in Settings.
 * - `stop`: before files are replaced or removed, stop every process running from the install
 *   folder, since Windows cannot replace a loaded `.exe` or `.node`. While the app's daemon has
 *   agents at work it refuses (`Refused`) and stops nothing: a person runs setup again once they
 *   finish. `stop --force` is for an update the app started, which has already drained its
 *   agents. The app itself ends first (it keeps no agent state, and would otherwise start its
 *   daemon again), then the daemon is asked to shut down (`POST /v1/stop`). Whatever still runs
 *   is ended on its own: never its process tree, which would reach provider CLIs and terminals.
 * - `uninstall`: `stop`, then take back what the app added outside its folder: the PATH
 *   entry, the `ace` command, the login item and the browser native-host registrations. The
 *   data home (`~\.ace`) always stays, as does an `ace` command a standalone install owns.
 *
 * Every step after the busy check is best effort and reported: a failed step never blocks.
 */
export interface SetupPorts {
  /** The installed app folder (`$INSTDIR`). */
  installDir: string;
  /** The daemon home, as the app resolves it (`~\.ace` unless ACE_HOME). */
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  userPath: UserPathRegistry;
  /** Prepares the home for writing (`prepareDaemonHome`); throws when the app must decide. */
  prepareHome(home: string): void;
  /** Writes the `ace` command for this install; a description of the outcome. */
  writeCommand(): Promise<string>;
  /** The `ace` command's content, or undefined when there is none. */
  readCommand(file: string): Promise<string | undefined>;
  /** Whether that content is the desktop app's command (not a standalone release's launcher). */
  isDesktopCommand(content: string): boolean;
  removeFile(file: string): Promise<void>;
  /** The pid named by the home's daemon lock, if any. */
  daemonPid(home: string): Promise<number | undefined>;
  /**
   * Threads still at work in the home's daemon `pid` (the maintenance lease's blockers), or
   * undefined when it does not answer.
   */
  busy(home: string, pid: number): Promise<number | undefined>;
  /** Asks the home's daemon `pid` to shut down; true when it accepted. */
  requestStop(home: string, pid: number): Promise<boolean>;
  /** Processes running an executable inside `directory`, never this one or its parent. */
  processesIn(directory: string): Promise<{ pid: number; path: string }[]>;
  alive(pid: number): boolean;
  /** Ends this one process; its children are left to their own owners. */
  kill(pid: number): Promise<void>;
  /** Removes login items (HKCU Run values) that start an executable inside `directory`. */
  removeLoginItems(directory: string): Promise<number>;
  /** Removes this home's browser native-host registrations. */
  removeNativeHosts(home: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/** How long a daemon may take to shut down cleanly before its process is ended. */
const daemonStopMs = 60_000;

function commandFile(home: string): { directory: string; file: string } {
  const directory = win32.join(home, "bin");
  return { directory, file: win32.join(directory, "ace.cmd") };
}

async function step(ports: SetupPorts, name: string, run: () => Promise<string | void>) {
  try {
    const outcome = await run();
    ports.log(`${name}: ${outcome ?? "done"}`);
    return true;
  } catch (error) {
    ports.log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function install(ports: SetupPorts, updated: boolean): Promise<void> {
  await step(ports, "ace command", async () => {
    ports.prepareHome(ports.home);
    return ports.writeCommand();
  });
  if (updated) return;
  await step(ports, "user PATH", async () =>
    (await addToUserPath(ports.userPath, commandFile(ports.home).directory, ports.env))
      ? "added"
      : "already there",
  );
}

/** Why `stop` left everything running: agents are at work in the app's daemon. */
export class Refused extends Error {
  readonly working: number;
  constructor(working: number) {
    super(
      `ace is still working on ${working} ${working === 1 ? "thread" : "threads"}. Let ${working === 1 ? "it" : "them"} finish or stop ${working === 1 ? "it" : "them"} in ace, then run setup again.`,
    );
    this.name = "Refused";
    this.working = working;
  }
}

const appExecutable = (path: string) => win32.basename(path).toLowerCase() === "ace.exe";

export async function stop(ports: SetupPorts, force: boolean): Promise<void> {
  const pid = await ports.daemonPid(ports.home);
  const running = await ports.processesIn(ports.installDir);
  // A daemon from a standalone install or another copy keeps running.
  const ours = pid !== undefined && ports.alive(pid) && running.some((found) => found.pid === pid);
  if (ours && !force) {
    const working = await ports.busy(ports.home, pid);
    if (working !== undefined && working > 0) throw new Refused(working);
  }
  await step(ports, "app", async () => {
    const apps = running.filter((found) => appExecutable(found.path));
    for (const found of apps) await ports.kill(found.pid);
    return `${apps.length} ended`;
  });
  await step(ports, "daemon", async () => {
    if (pid === undefined || !ours) return "not running from this install";
    if (!(await ports.requestStop(ports.home, pid))) return "did not accept a stop request";
    for (let waited = 0; waited < daemonStopMs && ports.alive(pid); waited += 250)
      await ports.sleep(250);
    return ports.alive(pid) ? "still running" : "stopped";
  });
  await step(ports, "processes", async () => {
    const left = await ports.processesIn(ports.installDir);
    for (const found of left) await ports.kill(found.pid);
    return `${left.length} ended`;
  });
}

export async function uninstall(ports: SetupPorts): Promise<void> {
  await stop(ports, false);
  const { directory, file } = commandFile(ports.home);
  let commandStays = false;
  await step(ports, "ace command", async () => {
    const content = await ports.readCommand(file);
    if (content === undefined) return "none";
    if (!ports.isDesktopCommand(content)) {
      commandStays = true;
      return "belongs to a standalone install; kept";
    }
    await ports.removeFile(file);
    return "removed";
  });
  if (!commandStays)
    await step(ports, "user PATH", async () =>
      (await removeFromUserPath(ports.userPath, directory, ports.env)) ? "removed" : "not there",
    );
  await step(
    ports,
    "login item",
    async () => `${await ports.removeLoginItems(ports.installDir)} removed`,
  );
  await step(ports, "browser native hosts", () => ports.removeNativeHosts(ports.home));
  ports.log(`data kept in ${ports.home}`);
}

export type SetupCommand = "install" | "update" | "stop" | "force-stop" | "uninstall";

/** Throws `Refused` when agents are at work; the entry turns that into exit code 2. */
export async function runSetup(command: SetupCommand, ports: SetupPorts): Promise<void> {
  if (command === "install" || command === "update") return install(ports, command === "update");
  if (command === "stop" || command === "force-stop") return stop(ports, command === "force-stop");
  return uninstall(ports);
}

/** The app folder from the bundled script's own location (`<app>\resources\setup`). */
export function installDirFrom(scriptDirectory: string): string {
  return join(scriptDirectory, "..", "..");
}
