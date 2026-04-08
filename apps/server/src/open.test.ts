import * as NodeServices from "@effect/platform-node/NodeServices";
import { chmodSync } from "node:fs";
import { OpenError } from "@ace/contracts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertSuccess } from "@effect/vitest/utils";
import { FileSystem, Path, Effect } from "effect";

import {
  isCommandAvailable,
  launchDetached,
  pickFolder,
  resolveAvailableEditors,
  resolveEditorLaunch,
  resolveFolderPickerLaunch,
  resolveRevealInFileManagerLaunch,
} from "./open";
import type { ProcessRunResult } from "./processRunner";

const makeResult = (overrides: Partial<ProcessRunResult> = {}): ProcessRunResult => ({
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "darwin",
      );
      assert.deepEqual(antigravityLaunch, {
        command: "agy",
        args: ["/tmp/workspace"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const traeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "trae" },
        "darwin",
      );
      assert.deepEqual(traeLaunch, {
        command: "trae",
        args: ["/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "darwin",
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const vscodeInsidersLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode-insiders" },
        "darwin",
      );
      assert.deepEqual(vscodeInsidersLaunch, {
        command: "code-insiders",
        args: ["/tmp/workspace"],
      });

      const vscodiumLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscodium" },
        "darwin",
      );
      assert.deepEqual(vscodiumLaunch, {
        command: "codium",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "darwin",
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("uses --goto when editor supports line/column suffixes", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const traeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "trae" },
        "darwin",
      );
      assert.deepEqual(traeLineAndColumn, {
        command: "trae",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        "darwin",
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeInsidersLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode-insiders" },
        "darwin",
      );
      assert.deepEqual(vscodeInsidersLineAndColumn, {
        command: "code-insiders",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodiumLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscodium" },
        "darwin",
      );
      assert.deepEqual(vscodiumLineAndColumn, {
        command: "codium",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        "darwin",
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

it.layer(NodeServices.layer)("resolveRevealInFileManagerLaunch", (it) => {
  it.effect("maps reveal commands by operating system", () =>
    Effect.gen(function* () {
      const macLaunch = yield* resolveRevealInFileManagerLaunch(
        { path: "/tmp/workspace/src/app.ts" },
        "darwin",
      );
      assert.deepEqual(macLaunch, {
        command: "open",
        args: ["-R", "/tmp/workspace/src/app.ts"],
      });

      const winLaunch = yield* resolveRevealInFileManagerLaunch(
        { path: "C:\\workspace\\src\\app.ts" },
        "win32",
      );
      assert.deepEqual(winLaunch, {
        command: "explorer",
        args: ["/select,", "C:\\workspace\\src\\app.ts"],
      });

      const linuxLaunch = yield* resolveRevealInFileManagerLaunch(
        { path: "/tmp/workspace/src/app.ts" },
        "linux",
      );
      assert.deepEqual(linuxLaunch, {
        command: "xdg-open",
        args: ["/tmp/workspace/src"],
      });
    }),
  );

  it.effect("rejects empty reveal paths", () =>
    Effect.gen(function* () {
      const result = yield* resolveRevealInFileManagerLaunch({ path: "   " }, "darwin").pipe(
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("launchDetached", (it) => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `ace-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-open-test-" });
      yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it.effect("does not treat bare files without executable extension as available on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-open-test-" });
      yield* fs.writeFileString(path.join(dir, "npm"), "echo nope\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    }),
  );

  it.effect("appends PATHEXT for commands with non-executable extensions on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-open-test-" });
      yield* fs.writeFileString(path.join(dir, "my.tool.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    }),
  );

  it.effect("uses platform-specific PATH delimiter for platform overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-open-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-open-test-" });
      yield* fs.writeFileString(path.join(firstDir, "code.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(secondDir, "code.CMD"), "MZ");
      const env = {
        PATH: `${firstDir};${secondDir}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-editors-" });

      yield* fs.writeFileString(path.join(dir, "trae.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "code-insiders.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "codium.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["trae", "vscode-insiders", "vscodium", "file-manager"]);
    }),
  );
});

it.layer(NodeServices.layer)("resolveFolderPickerLaunch", (it) => {
  it.effect("prefers zenity on linux when available", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-picker-test-" });
      const zenityPath = path.join(dir, "zenity");
      yield* fs.writeFileString(zenityPath, "#!/bin/sh\nexit 0\n");
      yield* Effect.sync(() => chmodSync(zenityPath, 0o755));

      const launch = yield* resolveFolderPickerLaunch("linux", { PATH: dir });
      assert.deepEqual(launch.command, "zenity");
    }),
  );

  it.effect("falls back to kdialog on linux", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-picker-test-" });
      const kdialogPath = path.join(dir, "kdialog");
      yield* fs.writeFileString(kdialogPath, "#!/bin/sh\nexit 0\n");
      yield* Effect.sync(() => chmodSync(kdialogPath, 0o755));

      const launch = yield* resolveFolderPickerLaunch("linux", { PATH: dir });
      assert.deepEqual(launch.command, "kdialog");
    }),
  );

  it.effect("fails on linux when no supported picker is installed", () =>
    Effect.gen(function* () {
      const result = yield* resolveFolderPickerLaunch("linux", { PATH: "" }).pipe(Effect.result);
      assertFailure(
        result,
        new OpenError({
          message:
            "Folder picker is unavailable. Install zenity or kdialog, or enter the path manually.",
        }),
      );
    }),
  );
});

it.layer(NodeServices.layer)("pickFolder", (it) => {
  it.effect("returns the selected folder path", () =>
    Effect.gen(function* () {
      const selectedPath = yield* pickFolder("darwin", { PATH: "/usr/bin" }, async () =>
        makeResult({ stdout: "/tmp/project\n" }),
      );

      assert.equal(selectedPath, "/tmp/project");
    }),
  );

  it.effect("treats picker cancellations as null", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-picker-test-" });
      const zenityPath = path.join(dir, "zenity");
      yield* fs.writeFileString(zenityPath, "#!/bin/sh\nexit 0\n");
      yield* Effect.sync(() => chmodSync(zenityPath, 0o755));

      const selectedPath = yield* pickFolder("linux", { PATH: dir }, async () =>
        makeResult({ code: 1 }),
      );

      assert.equal(selectedPath, null);
    }),
  );

  it.effect("surfaces picker failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ace-picker-test-" });
      const zenityPath = path.join(dir, "zenity");
      yield* fs.writeFileString(zenityPath, "#!/bin/sh\nexit 0\n");
      yield* Effect.sync(() => chmodSync(zenityPath, 0o755));

      const result = yield* pickFolder("linux", { PATH: dir }, async () =>
        makeResult({ code: 2, stderr: "boom" }),
      ).pipe(Effect.result);

      assertFailure(
        result,
        new OpenError({
          message: "Failed to open folder picker: boom",
        }),
      );
    }),
  );
});
