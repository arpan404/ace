import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { hostLaunch, hostTarget, openOnHost, type HostLaunch } from "./host-open.ts";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-host-open-")));
  folders.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "queue.ts"), "export {};\n");
  return root;
}

/** The target inside `root`, failing the test when it is refused. */
async function inside(root: string, path: string | undefined) {
  const found = await hostTarget(root, path);
  if (!found) throw new Error(`${path ?? "."} was refused`);
  return found;
}

const code = { id: "code", name: "Visual Studio Code", command: "/usr/local/bin/code" };

describe("opening a project on the machine running ace", () => {
  test("a file inside the project opens in the editor at its line", async () => {
    const root = await project();
    const found = await inside(root, "src/queue.ts");
    expect(found).toEqual({ target: join(root, "src", "queue.ts"), isFile: true });
    expect(
      hostLaunch({
        platform: "darwin",
        app: { kind: "editor", editorId: "code" },
        ...found,
        line: 12,
        editor: code,
      }),
    ).toEqual({
      command: "/usr/local/bin/code",
      args: ["-g", `${join(root, "src", "queue.ts")}:12`],
    });
  });

  test("a path that climbs out of the project is refused", async () => {
    const root = await project();
    expect(await hostTarget(root, "../..")).toBeUndefined();
    expect(await hostTarget(root, "/etc/hosts")).toBeUndefined();
  });

  test("a symlink pointing outside the project is refused", async () => {
    const root = await project();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ace-host-outside-")));
    folders.push(outside);
    await symlink(outside, join(root, "escape"));
    expect(await hostTarget(root, "escape")).toBeUndefined();
  });

  test("the file manager shows a file inside its folder on each platform", async () => {
    const root = await project();
    const found = await inside(root, "src/queue.ts");
    expect(hostLaunch({ platform: "darwin", app: { kind: "files" }, ...found })).toEqual({
      command: "open",
      args: ["-R", found.target],
    });
    expect(hostLaunch({ platform: "linux", app: { kind: "files" }, ...found })).toEqual({
      command: "xdg-open",
      args: [join(root, "src")],
    });
    expect(hostLaunch({ platform: "win32", app: { kind: "files" }, ...found })).toEqual({
      command: "explorer.exe",
      args: [`/select,${found.target}`],
    });
  });

  test("an editor this machine didn't find is never started", async () => {
    const root = await project();
    const found = await inside(root, undefined);
    expect(
      hostLaunch({
        platform: "darwin",
        app: { kind: "editor", editorId: "zed" },
        ...found,
        editor: undefined,
      }),
    ).toBeUndefined();
  });
});

/** Discovery that finishes only when the test says so, and a spawner that records starts. */
function held() {
  const discovery = Promise.withResolvers<(typeof code)[]>();
  const started: HostLaunch[] = [];
  return {
    finish: () => discovery.resolve([code]),
    editors: () => discovery.promise,
    spawn: async (launch: HostLaunch) => {
      started.push(launch);
    },
    started,
  };
}

describe("an open that waits on the machine", () => {
  test("a device revoked while editors are found never starts the editor", async () => {
    const root = await project();
    const machine = held();
    let allowed = true;
    const opening = openOnHost({
      root,
      app: { kind: "editor", editorId: "code" },
      platform: "darwin",
      editors: machine.editors,
      spawn: machine.spawn,
      allowed: () => allowed,
      signal: new AbortController().signal,
    });
    allowed = false;
    machine.finish();
    await expect(opening).rejects.toThrow("forbidden");
    expect(machine.started).toEqual([]);
  });

  test("a request cancelled while editors are found never starts the editor", async () => {
    const root = await project();
    const machine = held();
    const controller = new AbortController();
    const opening = openOnHost({
      root,
      app: { kind: "editor", editorId: "code" },
      platform: "darwin",
      editors: machine.editors,
      spawn: machine.spawn,
      allowed: () => true,
      signal: controller.signal,
    });
    controller.abort();
    machine.finish();
    await expect(opening).rejects.toThrow();
    expect(machine.started).toEqual([]);
  });

  test("a caller still allowed starts the editor once", async () => {
    const root = await project();
    const machine = held();
    machine.finish();
    await openOnHost({
      root,
      app: { kind: "editor", editorId: "code" },
      platform: "darwin",
      editors: machine.editors,
      spawn: machine.spawn,
      allowed: () => true,
      signal: new AbortController().signal,
    });
    expect(machine.started).toEqual([{ command: "/usr/local/bin/code", args: [root] }]);
  });
});

/** A Windows install: `<root>/bin/<id>.cmd` with `script`, and `<root>/Code.exe`. */
async function install(script: string, id = "code") {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ace-host-editor-")));
  folders.push(parent);
  const root = join(parent, "Microsoft VS Code");
  await mkdir(join(root, "bin"), { recursive: true });
  const launcher = join(root, "bin", `${id}.cmd`);
  await writeFile(launcher, script);
  await writeFile(join(root, "Code.exe"), "");
  const outside = join(parent, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "payload.exe"), "");
  return { root, launcher, outside };
}

/** Open the project with the Windows launcher at `launcher`; what started, or the refusal. */
async function openWith(launcher: string, id = "code") {
  const root = await project();
  const started: HostLaunch[] = [];
  const opening = openOnHost({
    root,
    app: { kind: "editor", editorId: id },
    platform: "win32",
    editors: async () => [{ id, name: "Editor", command: launcher }],
    spawn: async (launch) => {
      started.push(launch);
    },
    allowed: () => true,
    signal: new AbortController().signal,
  });
  return { root, started, opening };
}

const vscodeLauncher = [
  "@echo off",
  "setlocal",
  "set VSCODE_DEV=",
  "set ELECTRON_RUN_AS_NODE=1",
  '"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*',
  "IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%",
  "endlocal",
].join("\r\n");

describe("opening an editor on Windows", () => {
  test("VS Code's own launcher opens through Code.exe in its install, never a shell script", async () => {
    const editor = await install(vscodeLauncher);
    const { root, started, opening } = await openWith(editor.launcher);
    await opening;
    expect(started).toEqual([{ command: join(editor.root, "Code.exe"), args: [root] }]);
  });

  test("an executable named only in a comment is never the one started", async () => {
    const editor = await install(
      ['REM "%~dp0..\\Payload.exe"', ':: "%~dp0..\\Payload.exe"', vscodeLauncher].join("\r\n"),
    );
    await writeFile(join(editor.root, "Payload.exe"), "");
    const { root, started, opening } = await openWith(editor.launcher);
    await opening;
    expect(started).toEqual([{ command: join(editor.root, "Code.exe"), args: [root] }]);
    const commentOnly = await install('REM "%~dp0..\\Code.exe" %*');
    const refused = await openWith(commentOnly.launcher);
    await expect(refused.opening).rejects.toThrow("editor_launcher_unsupported");
    expect(refused.started).toEqual([]);
  });

  test("an absolute executable path is refused and nothing starts", async () => {
    const editor = await install("");
    await writeFile(editor.launcher, `"${join(editor.outside, "payload.exe")}" %*`);
    const windows = await install('"C:\\outside\\payload.exe" %*');
    for (const launcher of [editor.launcher, windows.launcher]) {
      const { started, opening } = await openWith(launcher);
      await expect(opening).rejects.toThrow("editor_launcher_unsupported");
      expect(started).toEqual([]);
    }
  });

  test("a launcher climbing out of the editor's install is refused", async () => {
    const editor = await install('"%~dp0..\\..\\outside\\payload.exe" %*');
    const { started, opening } = await openWith(editor.launcher);
    await expect(opening).rejects.toThrow("editor_launcher_unsupported");
    expect(started).toEqual([]);
  });

  test("an executable that links out of the install is refused", async () => {
    const editor = await install(vscodeLauncher);
    await rm(join(editor.root, "Code.exe"));
    await symlink(join(editor.outside, "payload.exe"), join(editor.root, "Code.exe"));
    const { started, opening } = await openWith(editor.launcher);
    await expect(opening).rejects.toThrow("editor_launcher_unsupported");
    expect(started).toEqual([]);
  });

  test("an editor whose install layout ace doesn't know is refused rather than guessed", async () => {
    const editor = await install(vscodeLauncher, "zed");
    const { started, opening } = await openWith(editor.launcher, "zed");
    await expect(opening).rejects.toThrow("editor_launcher_unsupported");
    expect(started).toEqual([]);
  });
});
