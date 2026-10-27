import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { hostLaunch, hostTarget } from "./host-open.ts";

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
