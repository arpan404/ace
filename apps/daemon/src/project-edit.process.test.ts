import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, Project, type ProjectDefaults, type WorkspaceChanged } from "@ace/protocol";
import { Projects } from "./projects.ts";
import { Store } from "./store.ts";
import { projectFixture } from "./projects-test-support.ts";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("a project's badge and new-thread defaults are pushed, listed and kept across a restart", async () => {
  const f = await projectFixture();
  let reopened: Store | undefined;
  let projects: Projects | undefined;
  try {
    const path = join(f.root, "site");
    await mkdir(path);
    const project = Project.parse((await f.command({ type: "workspace.add", path })).workspace);
    const changes: WorkspaceChanged[] = [];
    f.projects.subscribe((change) => changes.push(change));
    const defaults: ProjectDefaults = {
      provider: "codex",
      model: "gpt-5-codex",
      worktree: false,
      baseBranch: "dev",
    };
    expect(
      await f.command({
        type: "workspace.update",
        workspaceId: project.id,
        name: "Site",
        badge: { glyph: "rocket", color: "green" },
        defaults,
      }),
    ).toMatchObject({
      ok: true,
      workspace: { badge: { glyph: "rocket", color: "green" }, defaults },
    });
    expect(changes).toMatchObject([{ change: "updated", workspace: { name: "Site", defaults } }]);
    // A rename alone leaves the badge and defaults as they were.
    await f.command({ type: "workspace.rename", workspaceId: project.id, name: "Website" });
    expect(f.projects.catalog.page(undefined, 10).projects).toMatchObject([
      { name: "Website", badge: { glyph: "rocket", color: "green" }, defaults },
    ]);

    await f.projects.close();
    await f.store.close();
    reopened = new Store(join(f.root, "events.sqlite"));
    projects = new Projects(reopened, () => 2000, { home: f.root, roots: async () => [f.root] });
    expect(projects.catalog.get(project.id)).toMatchObject({
      badge: { glyph: "rocket", color: "green" },
      defaults,
    });
    expect(
      await projects.execute(
        Command.parse({
          id: "reset",
          deviceId: "owner",
          payload: {
            type: "workspace.update",
            workspaceId: project.id,
            name: "Website",
            badge: null,
            defaults: null,
          },
        }),
      ),
    ).toMatchObject({ ok: true });
    const reset = projects.catalog.get(project.id);
    expect(reset.badge).toBeUndefined();
    expect(reset.defaults).toBeUndefined();
  } finally {
    await projects?.close();
    await reopened?.close();
    await f.close();
  }
});

test("an image whose bytes aren't the type it names is refused and the saved image stays", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "app");
    await mkdir(path);
    const project = Project.parse((await f.command({ type: "workspace.add", path })).workspace);
    expect(
      await f.command({
        type: "workspace.update",
        workspaceId: project.id,
        name: "app",
        icon: png,
      }),
    ).toMatchObject({ ok: true, workspace: { icon: png } });
    for (const icon of [
      // "<script>" labelled as a PNG.
      "data:image/png;base64,PHNjcmlwdD4=",
      // A PNG labelled as a JPEG.
      "data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUg==",
    ])
      expect(
        await f.command({ type: "workspace.update", workspaceId: project.id, name: "app", icon }),
      ).toMatchObject({ ok: false, error: "project_icon_invalid" });
    expect(f.projects.catalog.get(project.id).icon).toBe(png);
    // The image lives in ace's own data, never as a file in the project.
    expect(await readdir(path)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("removing an edited project leaves its folder and files on disk", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "keep");
    await mkdir(path);
    await writeFile(join(path, "notes.md"), "keep me");
    const project = Project.parse((await f.command({ type: "workspace.add", path })).workspace);
    await f.command({
      type: "workspace.update",
      workspaceId: project.id,
      name: "Keep",
      icon: png,
      defaults: { worktree: true },
    });
    expect(
      await f.command({ type: "workspace.remove", workspaceId: project.id, archiveThreads: false }),
    ).toMatchObject({ ok: true });
    expect(f.projects.catalog.page(undefined, 10).projects).toEqual([]);
    expect(await readFile(join(path, "notes.md"), "utf8")).toBe("keep me");
  } finally {
    await f.close();
  }
});
