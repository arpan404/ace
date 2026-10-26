import { expect, test } from "vitest";
import { runSetup, type SetupPorts } from "./setup.ts";
import type { UserPath } from "./user-path.ts";

const installDir = "C:\\Users\\Ada\\AppData\\Local\\Programs\\ace";
const home = "C:\\Users\\Ada\\.ace";
const commandFile = `${home}\\bin\\ace.cmd`;
const desktopCommand = "@echo off\r\nREM desktop shim\r\n";

interface World {
  path: UserPath;
  files: Map<string, string>;
  processes: Map<number, string>;
  daemonPid?: number;
  /** The daemon exits when asked to stop. */
  stops: boolean;
  loginItems: number;
  nativeHosts: boolean;
  log: string[];
}

function world(overrides: Partial<World> = {}): World {
  return {
    path: { value: "C:\\Tools", kind: "ExpandString" },
    files: new Map(),
    processes: new Map(),
    stops: true,
    loginItems: 0,
    nativeHosts: false,
    log: [],
    ...overrides,
  };
}

function ports(state: World): SetupPorts {
  return {
    installDir,
    home,
    env: { USERPROFILE: "C:\\Users\\Ada" },
    userPath: {
      read: async () => state.path,
      write: async (path) => {
        state.path = path;
      },
    },
    prepareHome() {},
    async writeCommand() {
      state.files.set(commandFile, desktopCommand);
      return "written";
    },
    readCommand: async (file) => state.files.get(file),
    isDesktopCommand: (content) => content === desktopCommand,
    removeFile: async (file) => void state.files.delete(file),
    daemonPid: async () => state.daemonPid,
    async requestStop(_home, pid) {
      if (state.stops) state.processes.delete(pid);
      return state.stops;
    },
    processesIn: async (directory) =>
      [...state.processes]
        .filter(([, path]) => path.startsWith(`${directory}\\`))
        .map(([pid, path]) => ({ pid, path })),
    alive: (pid) => state.processes.has(pid),
    kill: async (pid) => void state.processes.delete(pid),
    async removeLoginItems() {
      const removed = state.loginItems;
      state.loginItems = 0;
      return removed;
    },
    removeNativeHosts: async () => {
      state.nativeHosts = false;
    },
    sleep: async () => {},
    log: (line) => state.log.push(line),
  };
}

test("a fresh install writes the ace command and puts its folder on the user PATH", async () => {
  const state = world();
  await runSetup("install", ports(state));
  expect(state.files.get(commandFile)).toBe(desktopCommand);
  expect(state.path.value).toBe(`C:\\Tools;${home}\\bin`);
});

test("an update refreshes the command but leaves PATH as the person set it", async () => {
  const state = world();
  await runSetup("update", ports(state));
  expect(state.files.get(commandFile)).toBe(desktopCommand);
  expect(state.path.value).toBe("C:\\Tools");
});

test("stopping before an update asks the app's daemon to shut down, then ends what is left", async () => {
  const state = world({
    daemonPid: 40,
    processes: new Map([
      [40, `${installDir}\\resources\\runtime\\node.exe`],
      [41, `${installDir}\\resources\\runtime\\node.exe`],
      [90, "C:\\Windows\\explorer.exe"],
    ]),
  });
  await runSetup("stop", ports(state));
  expect(state.log).toContain("daemon: stopped");
  expect([...state.processes.keys()]).toEqual([90]);
});

test("a daemon running from a standalone install keeps running through the app's update", async () => {
  const state = world({
    daemonPid: 50,
    processes: new Map([[50, `${home}\\releases\\1.0.0-win32-x64\\node.exe`]]),
  });
  await runSetup("stop", ports(state));
  expect(state.processes.has(50)).toBe(true);
});

test("a daemon that refuses to stop is ended so the files can be replaced", async () => {
  const state = world({
    daemonPid: 40,
    stops: false,
    processes: new Map([[40, `${installDir}\\resources\\runtime\\node.exe`]]),
  });
  await runSetup("stop", ports(state));
  expect(state.processes.size).toBe(0);
});

test("uninstall takes back the command, PATH entry, login item and native hosts, and keeps data", async () => {
  const state = world({
    path: { value: `C:\\Tools;${home}\\bin`, kind: "ExpandString" },
    files: new Map([
      [commandFile, desktopCommand],
      [`${home}\\state.sqlite`, "data"],
    ]),
    loginItems: 1,
    nativeHosts: true,
  });
  await runSetup("uninstall", ports(state));
  expect(state.files.has(commandFile)).toBe(false);
  expect(state.files.get(`${home}\\state.sqlite`)).toBe("data");
  expect(state.path.value).toBe("C:\\Tools");
  expect(state.loginItems).toBe(0);
  expect(state.nativeHosts).toBe(false);
});

test("uninstall keeps a standalone install's ace command and its PATH entry", async () => {
  const launcher = "@echo off\r\nREM release launcher\r\n";
  const state = world({
    path: { value: `C:\\Tools;${home}\\bin`, kind: "ExpandString" },
    files: new Map([[commandFile, launcher]]),
  });
  await runSetup("uninstall", ports(state));
  expect(state.files.get(commandFile)).toBe(launcher);
  expect(state.path.value).toBe(`C:\\Tools;${home}\\bin`);
});

test("a failed step is reported and the rest of uninstall still runs", async () => {
  const state = world({ files: new Map([[commandFile, desktopCommand]]), loginItems: 1 });
  const failing = {
    ...ports(state),
    userPath: {
      read: async () => {
        throw new Error("registry unavailable");
      },
      write: async () => {},
    },
  };
  await runSetup("uninstall", failing);
  expect(state.log).toContain("user PATH failed: registry unavailable");
  expect(state.loginItems).toBe(0);
});
