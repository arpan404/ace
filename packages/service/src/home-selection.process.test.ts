import { renameSync, symlinkSync } from "node:fs";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  chmod,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveDaemonHome, createDaemonHomeResolver, assertTestHomeIsolation } from "./index.ts";

async function layout(cleanup: (close: () => Promise<void>) => void) {
  const home = await mkdtemp(join(tmpdir(), "ace-home-selection-"));
  cleanup(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".ace"));
  await writeFile(join(home, ".ace/ace.db"), "untouched legacy data");
  return home;
}
const marker = (home: string) =>
  JSON.stringify({
    version: 1,
    owner: process.getuid?.() ?? 0,
    legacyHome: join(home, ".ace"),
    reason: "Legacy isolation; migration requires an explicit owner decision.",
  });
const select = (home: string) =>
  promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `import {resolveDaemonHome} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)}; console.log(resolveDaemonHome(${JSON.stringify(home)}));`,
  ]);

test("concurrent default launches all select the same isolated home without touching legacy data", async ({
  onTestFinished,
}) => {
  const home = await layout(onTestFinished);
  const selections = await Promise.all(Array.from({ length: 24 }, () => select(home)));
  expect(selections.map((result) => result.stdout.trim())).toEqual(
    Array(24).fill(join(home, ".ace-next")),
  );
  expect(await readFile(join(home, ".ace/ace.db"), "utf8")).toBe("untouched legacy data");
  expect(await readdir(join(home, ".ace"))).toEqual(["ace.db"]);
});

test("a launch waits for an in-progress selection before inspecting its incomplete marker", async ({
  onTestFinished,
}) => {
  const home = await layout(onTestFinished);
  await mkdir(join(home, ".ace-next"));
  const lock = join(home, ".ace-home-selection.lock");
  await writeFile(lock, "", { flag: "wx", mode: 0o600 });
  await writeFile(join(home, ".ace-next/legacy-home.json"), "{", { mode: 0o600 });
  const selected = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createDaemonHomeResolver,assertTestHomeIsolation} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import {PinnedDirectory} from ${JSON.stringify(new URL("../../workspace/src/pinned-directory.ts", import.meta.url).href)};
    const select = createDaemonHomeResolver({assertSafePath:assertTestHomeIsolation,open(path) {
      const parent = PinnedDirectory.atBoundary(path), create = parent.createExclusive.bind(parent);
      parent.createExclusive = (name) => {
        try { return create(name); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") process.send?.("selection-contended");
          throw error;
        }
      };
      return parent;
    }});
    console.log(select(${JSON.stringify(home)}));
    process.disconnect();
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  onTestFinished(() => {
    selected.kill();
  });
  let output = "";
  if (!selected.stdout) throw new Error("Missing selector output pipe");
  selected.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString();
  });
  const exited = once(selected, "close");
  await once(selected, "message");
  // Publish only once the other process is blocked on the filesystem lock boundary.
  await writeFile(join(home, ".ace-next/legacy-home.json"), marker(home), { mode: 0o600 });
  await unlink(lock);
  expect((await exited)[0]).toBe(0);
  expect(output.trim()).toBe(join(home, ".ace-next"));
  expect(await readdir(join(home, ".ace"))).toEqual(["ace.db"]);
});

test("a contender retries when the holder releases the lock after the contender opens it", async ({
  onTestFinished,
}) => {
  const home = await layout(onTestFinished);
  const lock = join(home, ".ace-home-selection.lock");
  await writeFile(lock, "", { flag: "wx", mode: 0o600 });
  const selected = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import fs from "node:fs";
    import {syncBuiltinESMExports} from "node:module";
    import {createDaemonHomeResolver,assertTestHomeIsolation} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import {PinnedDirectory} from "@ace/workspace/pinned-directory";
    let readingLock = false, paused = false;
    const stat = fs.fstatSync;
    fs.fstatSync = (fd, ...args) => {
      if (readingLock && !paused) {
        paused = true;
        fs.writeSync(1, "lock-opened\\n");
        if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("Missing release barrier");
      }
      return stat(fd, ...args);
    };
    syncBuiltinESMExports();
    const select = createDaemonHomeResolver({assertSafePath:assertTestHomeIsolation,open(path) {
      const parent = PinnedDirectory.atBoundary(path), read = parent.readText.bind(parent);
      parent.readText = (name, ...args) => {
        readingLock = name === ".ace-home-selection.lock";
        try { return read(name, ...args); }
        finally { readingLock = false; }
      };
      return parent;
    }});
    console.log(select(${JSON.stringify(home)}));
  `,
    ],
    { cwd: new URL("../", import.meta.url), stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(selected, "close");
  onTestFinished(async () => {
    if (selected.exitCode === null && selected.signalCode === null) selected.kill("SIGKILL");
    await exited;
  });
  let output = "",
    errors = "";
  const opened = Promise.withResolvers<void>();
  selected.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString();
    if (output.includes("lock-opened\n")) opened.resolve();
  });
  selected.stderr.on("data", (bytes: Buffer) => {
    errors += bytes.toString();
  });
  await Promise.race([
    opened.promise,
    exited.then(() => {
      throw new Error(`Contender exited before opening lock: ${errors}`);
    }),
  ]);
  // The contender owns a real descriptor to this inode before the holder unlinks it.
  await unlink(lock);
  selected.stdin.end("continue");
  expect((await exited)[0], errors).toBe(0);
  expect(output.trim().split("\n").at(-1)).toBe(join(home, ".ace-next"));
  expect(await readFile(join(home, ".ace/ace.db"), "utf8")).toBe("untouched legacy data");
  expect(await readdir(join(home, ".ace"))).toEqual(["ace.db"]);
});

for (const unsafe of [
  "symlink",
  "directory",
  "oversized",
  "public permissions",
  "multiple hard links",
])
  test(`a selection lock with ${unsafe} is refused without touching legacy data`, async ({
    onTestFinished,
  }) => {
    const home = await layout(onTestFinished);
    const lock = join(home, ".ace-home-selection.lock");
    if (unsafe === "symlink") await symlink(join(home, ".ace/ace.db"), lock);
    else if (unsafe === "directory") await mkdir(lock);
    else {
      await writeFile(lock, unsafe === "oversized" ? " ".repeat(129) : "", { mode: 0o600 });
      if (unsafe === "public permissions") await chmod(lock, 0o644);
      if (unsafe === "multiple hard links") await link(lock, join(home, "lock-copy"));
    }
    expect(() => resolveDaemonHome(home)).toThrow(/regular|symbolic|symlink|ELOOP/i);
    await expect(readdir(join(home, ".ace-next"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(home, ".ace/ace.db"), "utf8")).toBe("untouched legacy data");
    expect(await readdir(join(home, ".ace"))).toEqual(["ace.db"]);
  });

for (const invalid of [
  "empty",
  "malformed",
  "directory",
  "interrupted",
  "wrong home",
  "wrong owner",
  "oversized",
  "symlink",
])
  test(`a ${invalid} isolation marker cannot authorize an unknown populated home`, async ({
    onTestFinished,
  }) => {
    const home = await layout(onTestFinished),
      next = join(home, ".ace-next");
    await mkdir(next);
    await writeFile(join(next, "unknown-data"), "keep this data");
    const path = join(next, "legacy-home.json");
    if (invalid === "directory") await mkdir(path);
    else if (invalid === "symlink") await symlink(join(home, ".ace/ace.db"), path);
    else
      await writeFile(
        path,
        invalid === "empty"
          ? ""
          : invalid === "malformed"
            ? "{}"
            : invalid === "interrupted"
              ? "{"
              : invalid === "oversized"
                ? " ".repeat(4097)
                : invalid === "wrong home"
                  ? marker(home + "-other")
                  : marker(home).replace(`"owner":${process.getuid?.() ?? 0}`, '"owner":999999'),
        { mode: 0o600 },
      );
    expect(() => resolveDaemonHome(home)).toThrow(/marker|symbolic|symlink|regular/i);
    expect(await readFile(join(next, "unknown-data"), "utf8")).toBe("keep this data");
    expect(await readFile(join(home, ".ace/ace.db"), "utf8")).toBe("untouched legacy data");
  });

test("an isolated-home symlink cannot redirect marker publication into the legacy home", async ({
  onTestFinished,
}) => {
  const home = await layout(onTestFinished);
  await symlink(join(home, ".ace"), join(home, ".ace-next"));
  expect(() => resolveDaemonHome(home)).toThrow();
  expect(await readdir(join(home, ".ace"))).toEqual(["ace.db"]);
});

test("replacing the isolated directory during publication cannot write a marker into legacy data", async ({
  onTestFinished,
}) => {
  const home = await layout(onTestFinished);
  const next = join(home, ".ace-next");
  const resolver = createDaemonHomeResolver({
    assertSafePath: assertTestHomeIsolation,
    open(path) {
      const parent = PinnedDirectory.atBoundary(path),
        makeDirectory = parent.mkdir.bind(parent);
      parent.mkdir = (name) => {
        const directory = makeDirectory(name),
          publish = directory.publish.bind(directory);
        directory.publish = (file, text) => {
          renameSync(next, join(home, "detached-next"));
          symlinkSync(join(home, ".ace"), next);
          publish(file, text);
        };
        return directory;
      };
      return parent;
    },
  });
  expect(() => resolver(home)).toThrow(/changed|symbolic|symlink|directory/i);
  expect(await readdir(join(home, ".ace"))).toEqual(["ace.db"]);
  expect(await readFile(join(home, ".ace/ace.db"), "utf8")).toBe("untouched legacy data");
});

for (const unsafe of ["public permissions", "multiple hard links"])
  test(`a marker with ${unsafe} cannot authorize unknown data`, async ({ onTestFinished }) => {
    const home = await layout(onTestFinished),
      next = join(home, ".ace-next");
    await mkdir(next);
    await writeFile(join(next, "unknown-data"), "leave alone");
    const path = join(next, "legacy-home.json");
    if (unsafe === "public permissions") {
      await writeFile(path, marker(home), { mode: 0o600 });
      await chmod(path, 0o644);
    } else {
      const source = join(home, "marker-copy");
      await writeFile(source, marker(home), { mode: 0o600 });
      await link(source, path);
    }
    expect(() => resolveDaemonHome(home)).toThrow(/marker/);
    expect(await readFile(join(next, "unknown-data"), "utf8")).toBe("leave alone");
    expect(await readdir(join(home, ".ace"))).toEqual(["ace.db"]);
  });
