import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { hostLaunch, hostTarget, openOnHost, spawnDetached, type HostLaunch } from "./host-open.ts";

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
      command: join("C:\\Windows", "explorer.exe"),
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

/** Open the project with `editor` on Windows; what started, or the refusal. */
async function openOnWindows(editor: { id: string; name: string; command: string }) {
  const root = await project();
  const started: HostLaunch[] = [];
  const opening = openOnHost({
    root,
    app: { kind: "editor", editorId: editor.id },
    platform: "win32",
    editors: async () => [editor],
    spawn: async (launch) => {
      started.push(launch);
    },
    allowed: () => true,
    signal: new AbortController().signal,
  });
  return { root, started, opening };
}

describe("opening an editor on Windows", () => {
  test("an editor's own .exe starts directly, with the folder as its own argument", async () => {
    const exe = join(await project(), "Code.exe");
    await writeFile(exe, "");
    const { root, started, opening } = await openOnWindows({
      id: "code",
      name: "Code",
      command: exe,
    });
    await opening;
    expect(started).toEqual([{ command: exe, args: [root] }]);
  });

  test("a .cmd or .bat launcher is never started, whatever discovery returned", async () => {
    for (const command of ["C:\\tools\\code.cmd", "C:\\tools\\cursor.bat", "code"]) {
      const { started, opening } = await openOnWindows({ id: "code", name: "Code", command });
      await expect(opening).rejects.toThrow("editor_not_found");
      expect(started).toEqual([]);
    }
  });

  test("the file manager is always the system's own Explorer", async () => {
    const root = await project();
    const found = await inside(root, "src/queue.ts");
    expect(
      hostLaunch({
        platform: "win32",
        app: { kind: "files" },
        ...found,
        systemRoot: "D:\\Windows",
      }),
    ).toEqual({ command: join("D:\\Windows", "explorer.exe"), args: [`/select,${found.target}`] });
  });
});

describe("the process ace starts", () => {
  test("arguments are never read by a shell", async () => {
    if (process.platform === "win32") return;
    const root = await project();
    const marker = join(root, "shell-ran");
    await spawnDetached({
      command: "/usr/bin/true",
      args: [`; touch ${marker}`, `$(touch ${marker})`],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(stat(marker)).rejects.toThrow();
  });
});
