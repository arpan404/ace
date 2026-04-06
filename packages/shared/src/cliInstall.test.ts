import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureAceCliInstalled, pathHasEntry, resolveAceCliBinDir } from "./cliInstall";

function makeTempDir(prefix: string): string {
  return FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
}

describe("pathHasEntry", () => {
  it("matches win32 PATH entries case-insensitively", () => {
    expect(
      pathHasEntry(
        String.raw`C:\Windows\System32;C:\Users\Test\.ace\bin`,
        String.raw`c:\users\test\.ace\bin\`,
        "win32",
      ),
    ).toBe(true);
  });
});

describe("ensureAceCliInstalled", () => {
  it("writes a managed launcher and shell PATH block on unix-like systems", () => {
    const homeDir = makeTempDir("ace-cli-install-unix-");
    const baseDir = Path.join(homeDir, ".ace");
    const appDir = Path.join(homeDir, "Applications", "ace");
    const launchCommand = Path.join(appDir, "ace");
    const cliEntry = Path.join(appDir, "apps", "server", "dist", "bin.mjs");
    FS.mkdirSync(Path.dirname(cliEntry), { recursive: true });
    FS.writeFileSync(launchCommand, "");
    FS.writeFileSync(cliEntry, "");

    const env = {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
    } satisfies NodeJS.ProcessEnv;

    const first = ensureAceCliInstalled({
      baseDir,
      platform: "darwin",
      homeDir,
      env,
      shell: "/bin/zsh",
      target: {
        launchCommand,
        cliEntry,
        environment: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    });

    const commandPath = Path.join(resolveAceCliBinDir({ baseDir, homeDir }), "ace");
    expect(first.ready).toBe(true);
    expect(first.pathChanged).toBe(true);
    expect(first.restartRequired).toBe(true);
    expect(env.PATH?.startsWith(`${Path.join(baseDir, "bin")}:`)).toBe(true);
    expect(FS.readFileSync(commandPath, "utf8")).toContain("ELECTRON_RUN_AS_NODE");
    expect(FS.readFileSync(commandPath, "utf8")).toContain(cliEntry);
    expect(FS.readFileSync(Path.join(homeDir, ".zprofile"), "utf8")).toContain(
      "# >>> ace cli >>>",
    );
    expect(FS.readFileSync(Path.join(homeDir, ".zshrc"), "utf8")).toContain(
      "ACE_CLI_BIN_DIR",
    );

    const second = ensureAceCliInstalled({
      baseDir,
      platform: "darwin",
      homeDir,
      env,
      shell: "/bin/zsh",
      target: {
        launchCommand,
        cliEntry,
        environment: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    });

    expect(second.changed).toBe(false);
    expect(second.pathChanged).toBe(false);
    expect(second.ready).toBe(true);
  });

  it("writes a cmd shim and updates the user PATH on win32", () => {
    const homeDir = makeTempDir("ace-cli-install-win-");
    const baseDir = Path.join(homeDir, ".ace");
    const appDir = Path.join(homeDir, "App");
    const launchCommand = Path.join(appDir, "ace.exe");
    const cliEntry = Path.join(appDir, "apps", "server", "dist", "bin.mjs");
    FS.mkdirSync(Path.dirname(cliEntry), { recursive: true });
    FS.writeFileSync(launchCommand, "");
    FS.writeFileSync(cliEntry, "");

    let userPath = "C:\\Windows\\System32";
    const env = {
      PATH: userPath,
    } satisfies NodeJS.ProcessEnv;

    const result = ensureAceCliInstalled({
      baseDir,
      platform: "win32",
      homeDir,
      env,
      target: {
        launchCommand,
        cliEntry,
        environment: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
      readWindowsUserPath: () => userPath,
      writeWindowsUserPath: (value) => {
        userPath = value;
      },
    });

    const commandPath = Path.join(resolveAceCliBinDir({ baseDir, homeDir }), "ace.cmd");
    expect(result.ready).toBe(true);
    expect(result.pathChanged).toBe(true);
    expect(result.commandPath).toBe(commandPath);
    expect(userPath.startsWith(Path.join(baseDir, "bin"))).toBe(true);
    expect(env.PATH?.startsWith(`${Path.join(baseDir, "bin")};`)).toBe(true);
    expect(FS.readFileSync(commandPath, "utf8")).toContain("@echo off");
    expect(FS.readFileSync(commandPath, "utf8")).toContain("ELECTRON_RUN_AS_NODE");
  });
});
