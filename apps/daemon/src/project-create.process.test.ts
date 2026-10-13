import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@ace/protocol";
import { expect, test } from "vitest";
import { projectFixture } from "./projects-test-support.ts";

test("adding a missing folder with create makes it and its missing parents, then registers it", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "work", "new-app");
    const result = await f.command({ type: "workspace.add", path, create: true });
    expect(result).toMatchObject({ ok: true, workspace: { name: "new-app", path } });
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(await readdir(path)).toEqual([]);
    expect(f.projects.catalog.recent(100)).toEqual([result.workspace]);
  } finally {
    await f.close();
  }
});

test("an existing folder asked to be created is just added, with what's inside kept", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "existing");
    await mkdir(path);
    await writeFile(join(path, "notes.txt"), "keep me");
    const result = await f.command({ type: "workspace.add", path, create: true });
    expect(result).toMatchObject({ ok: true, workspace: { name: "existing", path } });
    expect(await readdir(path)).toEqual(["notes.txt"]);
  } finally {
    await f.close();
  }
});

test("a file at the path or on the way to it is refused as in the way, and nothing is made", async () => {
  const f = await projectFixture();
  try {
    await writeFile(join(f.root, "taken"), "a file");
    for (const path of [join(f.root, "taken"), join(f.root, "taken", "inside", "app")])
      expect(await f.command({ type: "workspace.add", path, create: true })).toMatchObject({
        ok: false,
        error: "blocked_by_file",
      });
    expect((await stat(join(f.root, "taken"))).isFile()).toBe(true);
    expect(f.projects.catalog.recent(100)).toEqual([]);
  } finally {
    await f.close();
  }
});

test.skipIf(process.getuid?.() === 0)(
  "a folder that can't be written into is refused as permission denied",
  async () => {
    const f = await projectFixture();
    const locked = join(f.root, "locked");
    try {
      await mkdir(locked);
      await chmod(locked, 0o555);
      const path = join(locked, "deeper", "app");
      expect(await f.command({ type: "workspace.add", path, create: true })).toMatchObject({
        ok: false,
        error: "permission_denied",
      });
      expect(await readdir(locked)).toEqual([]);
      expect(f.projects.catalog.recent(100)).toEqual([]);
    } finally {
      await chmod(locked, 0o755).catch(() => undefined);
      await f.close();
    }
  },
);

test("creating outside the allowed roots or through traversal makes nothing", async () => {
  const f = await projectFixture();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "ace-outside-")));
  try {
    expect(
      await f.command({ type: "workspace.add", path: join(outside, "app"), create: true }),
    ).toMatchObject({ ok: false, error: "outside_project_roots" });
    expect(existsSync(join(outside, "app"))).toBe(false);
    expect(
      await f.command({
        type: "workspace.add",
        path: `${f.root}/a/../../escaped`,
        create: true,
      }),
    ).toMatchObject({ ok: false, error: "invalid_path" });
    expect(existsSync(join(f.root, "a"))).toBe(false);
    expect(
      await f.command({ type: "workspace.add", path: "relative/app", create: true }),
    ).toMatchObject({ ok: false, error: "invalid_path" });
  } finally {
    await rm(outside, { recursive: true, force: true });
    await f.close();
  }
});

test("folders made for a project that then can't be registered are removed again", async () => {
  const f = await projectFixture();
  try {
    const top = join(f.root, "made");
    const path = join(top, "app");
    // The device loses access once the folders exist, before registration.
    const result = await f.projects.execute(
      Command.parse({
        id: "revoked",
        deviceId: "owner",
        payload: { type: "workspace.add", path, create: true },
      }),
      () => !existsSync(path),
    );
    expect(result).toMatchObject({ ok: false, error: "forbidden" });
    expect(existsSync(top)).toBe(false);
    expect(f.projects.catalog.recent(100)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a missing project root is offered for creating, then made and saved beside home", async () => {
  let saved: string[] = [];
  const f = await projectFixture({
    roots: async () => saved,
    saveRoots: async (roots) => {
      saved = roots;
    },
  });
  try {
    const path = join(f.root, "projects", "client-work");
    expect(await f.command({ type: "workspace.root.add", path })).toMatchObject({
      ok: false,
      error: "directory_missing",
    });
    expect(existsSync(join(f.root, "projects"))).toBe(false);
    expect(await f.command({ type: "workspace.root.add", path, create: true })).toMatchObject({
      ok: true,
    });
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(saved).toEqual([f.root, path]);
    await writeFile(join(f.root, "a-file"), "text");
    expect(
      await f.command({ type: "workspace.root.add", path: join(f.root, "a-file"), create: true }),
    ).toMatchObject({ ok: false, error: "blocked_by_file" });
    expect(saved).toEqual([f.root, path]);
  } finally {
    await f.close();
  }
});

test("a project root that can't be saved leaves no folder behind", async () => {
  const f = await projectFixture({
    saveRoots: async () => {
      throw new Error("settings_unavailable");
    },
  });
  try {
    const path = join(f.root, "unsaved");
    expect(await f.command({ type: "workspace.root.add", path, create: true })).toMatchObject({
      ok: false,
    });
    expect(existsSync(path)).toBe(false);
  } finally {
    await f.close();
  }
});
