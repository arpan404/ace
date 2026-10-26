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
 *   folder. The daemon is asked to shut down first (`POST /v1/stop`), so agents stop cleanly;
 *   Windows cannot replace a loaded `.exe` or `.node`.
 * - `uninstall`: `stop`, then take back what the app added outside its folder: the PATH
 *   entry, the `ace` command, the login item and the browser native-host registrations. The
 *   data home (`~\.ace`) always stays, as does an `ace` command a standalone install owns.
 *
 * Every step is best effort and reported: a failed step never blocks the installer.
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
  /** Asks the home's daemon `pid` to shut down; true when it accepted. */
  requestStop(home: string, pid: number): Promise<boolean>;
  /** Processes running an executable inside `directory`, never this one or its parent. */
  processesIn(directory: string): Promise<{ pid: number; path: string }[]>;
  alive(pid: number): boolean;
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

export async function stop(ports: SetupPorts): Promise<void> {
  await step(ports, "daemon", async () => {
    const pid = await ports.daemonPid(ports.home);
    if (pid === undefined || !ports.alive(pid)) return "not running";
    const running = await ports.processesIn(ports.installDir);
    // A daemon from a standalone install or another copy keeps running.
    if (!running.some((process) => process.pid === pid)) return "runs from elsewhere; left running";
    if (!(await ports.requestStop(ports.home, pid))) return "did not accept a stop request";
    for (let waited = 0; waited < daemonStopMs && ports.alive(pid); waited += 250)
      await ports.sleep(250);
    return ports.alive(pid) ? "still running" : "stopped";
  });
  await step(ports, "processes", async () => {
    const running = await ports.processesIn(ports.installDir);
    for (const process of running) await ports.kill(process.pid);
    return `${running.length} ended`;
  });
}

export async function uninstall(ports: SetupPorts): Promise<void> {
  await stop(ports);
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

export type SetupCommand = "install" | "update" | "stop" | "uninstall";

export async function runSetup(command: SetupCommand, ports: SetupPorts): Promise<void> {
  if (command === "install" || command === "update") return install(ports, command === "update");
  if (command === "stop") return stop(ports);
  return uninstall(ports);
}

/** The app folder from the bundled script's own location (`<app>\resources\setup`). */
export function installDirFrom(scriptDirectory: string): string {
  return join(scriptDirectory, "..", "..");
}
