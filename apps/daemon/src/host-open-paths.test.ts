import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openOnHost, type HostLaunch } from "./host-open.ts";
import { expandHostPath } from "./host-open-target.ts";

/*
 * `host.open` with a path anywhere on the machine: who may open it is decided by where it
 * resolves to, never by what the client wrote.
 */

const folders: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  await Promise.all(folders.splice(0).map((made) => rm(made, { recursive: true, force: true })));
});

async function folder(name: string) {
  const path = await realpath(await mkdtemp(join(tmpdir(), `ace-host-${name}-`)));
  folders.push(path);
  return path;
}

/** A home with a project, a personal skills folder and an unrelated folder in it. */
async function machine() {
  const home = await folder("home");
  const project = join(home, "code", "app");
  const skills = join(home, ".agents", "skills");
  const elsewhere = join(home, "Documents");
  for (const dir of [project, join(skills, "review"), elsewhere])
    await mkdir(dir, { recursive: true });
  await writeFile(join(project, "main.ts"), "export {};\n");
  await writeFile(join(skills, "review", "SKILL.md"), "# Review\n");
  await writeFile(join(elsewhere, "taxes.txt"), "private\n");
  return { home, project, skills, elsewhere };
}

const code = { id: "code", name: "Visual Studio Code", command: "/usr/local/bin/code" };

/** Open `path` as a device holding `scopes`; what started, or the refusal. */
async function open(
  at: Awaited<ReturnType<typeof machine>>,
  path: string,
  scopes: readonly ("operate" | "admin")[],
  app: { kind: "editor"; editorId: string } | { kind: "files" } = {
    kind: "editor",
    editorId: "code",
  },
) {
  const started: HostLaunch[] = [];
  const opening = openOnHost({
    place: {
      kind: "host",
      path,
      home: at.home,
      places: () => ({ projects: [at.project], skills: [at.skills] }),
    },
    app,
    platform: "darwin",
    editors: async () => [code],
    spawn: async (launch) => {
      started.push(launch);
    },
    // `admin` includes `operate`, as the daemon's own scope check does.
    allowed: (scope) => scopes.includes("admin") || scopes.includes(scope),
    signal: new AbortController().signal,
  });
  return { started, opening };
}

describe("who may open a path on the machine", () => {
  test("a phone with operate access opens a file inside a project", async () => {
    const at = await machine();
    const { started, opening } = await open(at, join(at.project, "main.ts"), ["operate"]);
    await opening;
    expect(started).toEqual([{ command: code.command, args: [join(at.project, "main.ts")] }]);
  });

  test("a phone with operate access can't open a file outside every project", async () => {
    const at = await machine();
    const { started, opening } = await open(at, join(at.elsewhere, "taxes.txt"), ["operate"]);
    await expect(opening).rejects.toThrow("owner_only");
    expect(started).toEqual([]);
  });

  test("the owner opens a file anywhere on the machine", async () => {
    const at = await machine();
    const { started, opening } = await open(at, join(at.elsewhere, "taxes.txt"), ["admin"]);
    await opening;
    expect(started).toEqual([{ command: code.command, args: [join(at.elsewhere, "taxes.txt")] }]);
  });

  test("a symlink in a project that points outside it needs the owner", async () => {
    const at = await machine();
    await symlink(at.elsewhere, join(at.project, "docs"));
    const phone = await open(at, join(at.project, "docs", "taxes.txt"), ["operate"]);
    await expect(phone.opening).rejects.toThrow("owner_only");
    expect(phone.started).toEqual([]);
    const owner = await open(at, join(at.project, "docs", "taxes.txt"), ["admin"]);
    await owner.opening;
    // What starts is the resolved file, never the link the client named.
    expect(owner.started[0]?.args).toEqual([join(at.elsewhere, "taxes.txt")]);
  });

  test("a path that climbs out of a project with .. is judged where it lands", async () => {
    const at = await machine();
    const { started, opening } = await open(
      at,
      join(at.project, "..", "..", "Documents", "taxes.txt"),
      ["operate"],
    );
    await expect(opening).rejects.toThrow("owner_only");
    expect(started).toEqual([]);
  });
});

describe("personal skill folders", () => {
  test("a phone with operate access opens the skills folder and a skill in it", async () => {
    const at = await machine();
    const root = await open(at, "~/.agents/skills", ["operate"], { kind: "files" });
    await root.opening;
    expect(root.started).toEqual([{ command: "open", args: [at.skills] }]);
    const skill = await open(at, "~/.agents/skills/review/SKILL.md", ["operate"]);
    await skill.opening;
    expect(skill.started[0]?.args).toEqual([join(at.skills, "review", "SKILL.md")]);
  });

  test("a skills folder kept elsewhere through a symlink still opens", async () => {
    const at = await machine();
    const dotfiles = await folder("dotfiles");
    await mkdir(join(dotfiles, "ship"));
    await writeFile(join(dotfiles, "ship", "SKILL.md"), "# Ship\n");
    await rm(at.skills, { recursive: true });
    await symlink(dotfiles, at.skills);
    const { started, opening } = await open(at, "~/.agents/skills/ship/SKILL.md", ["operate"]);
    await opening;
    expect(started[0]?.args).toEqual([join(dotfiles, "ship", "SKILL.md")]);
  });

  test("a skill linked in from outside the skills folder needs the owner", async () => {
    const at = await machine();
    await symlink(at.elsewhere, join(at.skills, "borrowed"));
    const { started, opening } = await open(at, "~/.agents/skills/borrowed/taxes.txt", ["operate"]);
    await expect(opening).rejects.toThrow("owner_only");
    expect(started).toEqual([]);
  });
});

describe("what is never opened", () => {
  test("a path that doesn't exist is refused", async () => {
    const at = await machine();
    const { started, opening } = await open(at, join(at.project, "gone.ts"), ["admin"]);
    await expect(opening).rejects.toThrow("path_not_found");
    expect(started).toEqual([]);
  });

  test("a device file is refused even for the owner", async () => {
    if (process.platform === "win32") return;
    const at = await machine();
    const { started, opening } = await open(at, "/dev/null", ["admin"]);
    await expect(opening).rejects.toThrow("path_not_openable");
    expect(started).toEqual([]);
  });

  test("a socket is refused even inside a project", async () => {
    if (process.platform === "win32") return;
    const at = await machine();
    const path = join(at.project, "daemon.sock");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => server.listen(path, done));
    const { started, opening } = await open(at, path, ["admin"]);
    await expect(opening).rejects.toThrow("path_not_openable");
    expect(started).toEqual([]);
  });

  test("an app bundle is revealed in the file manager, never run", async () => {
    const at = await machine();
    const bundle = join(at.project, "Tool.app");
    await mkdir(join(bundle, "Contents"), { recursive: true });
    const { started, opening } = await open(at, bundle, ["operate"], { kind: "files" });
    await opening;
    expect(started).toEqual([{ command: "open", args: ["-R", bundle] }]);
  });

  test("a link retargeted outside the project while editors are found never opens", async () => {
    const at = await machine();
    const link = join(at.project, "current.ts");
    await symlink(join(at.project, "main.ts"), link);
    const discovery = Promise.withResolvers<(typeof code)[]>();
    const entered = Promise.withResolvers<void>();
    const started: HostLaunch[] = [];
    const opening = openOnHost({
      place: {
        kind: "host",
        path: link,
        home: at.home,
        places: () => ({ projects: [at.project], skills: [at.skills] }),
      },
      app: { kind: "editor", editorId: "code" },
      platform: "darwin",
      editors: () => {
        entered.resolve();
        return discovery.promise;
      },
      spawn: async (launch) => {
        started.push(launch);
      },
      allowed: (scope) => scope === "operate",
      signal: new AbortController().signal,
    });
    await entered.promise;
    await unlink(link);
    await symlink(join(at.elsewhere, "taxes.txt"), link);
    discovery.resolve([code]);
    await expect(opening).rejects.toThrow("path_not_found");
    expect(started).toEqual([]);
  });

  test("an owner who loses admin while editors are found never opens outside a project", async () => {
    const at = await machine();
    let admin = true;
    const discovery = Promise.withResolvers<(typeof code)[]>();
    const entered = Promise.withResolvers<void>();
    const started: HostLaunch[] = [];
    const opening = openOnHost({
      place: {
        kind: "host",
        path: join(at.elsewhere, "taxes.txt"),
        home: at.home,
        places: () => ({ projects: [at.project], skills: [at.skills] }),
      },
      app: { kind: "editor", editorId: "code" },
      platform: "darwin",
      editors: () => {
        entered.resolve();
        return discovery.promise;
      },
      spawn: async (launch) => {
        started.push(launch);
      },
      allowed: (scope) => scope === "operate" || admin,
      signal: new AbortController().signal,
    });
    await entered.promise;
    admin = false;
    discovery.resolve([code]);
    await expect(opening).rejects.toThrow("owner_only");
    expect(started).toEqual([]);
  });
});

describe("reading the path a client names", () => {
  test("~ means the machine's home folder", () => {
    expect(expandHostPath("~", "/Users/ada", "darwin")).toBe("/Users/ada");
    expect(expandHostPath("~/notes.md", "/Users/ada", "darwin")).toBe("/Users/ada/notes.md");
    expect(expandHostPath("~\\notes.md", "C:\\Users\\ada", "win32")).toBe(
      "C:\\Users\\ada\\notes.md",
    );
  });

  test("relative paths and other people's homes are refused", () => {
    expect(expandHostPath("notes.md", "/Users/ada", "darwin")).toBeUndefined();
    expect(expandHostPath("~bob/notes.md", "/Users/ada", "darwin")).toBeUndefined();
  });

  test("Windows network and device paths are refused before anything reads them", () => {
    for (const path of ["\\\\server\\share\\a.txt", "//server/share/a.txt", "\\\\?\\C:\\a.txt"])
      expect(expandHostPath(path, "C:\\Users\\ada", "win32")).toBeUndefined();
    expect(expandHostPath("C:\\Users\\ada\\a.txt", "C:\\Users\\ada", "win32")).toBe(
      "C:\\Users\\ada\\a.txt",
    );
  });
});
