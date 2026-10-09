import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Project } from "@ace/protocol";
import { projectFixture } from "./projects-test-support.ts";
import { Store } from "./store.ts";
import { Projects } from "./projects.ts";

const png = await (
  await import("sharp")
)
  .default({
    create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
  .png()
  .toBuffer();

test("a local favicon supplies the default while a custom icon overrides it and clearing restores it", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "project");
    await mkdir(join(path, "public"), { recursive: true });
    await writeFile(join(path, "public", "favicon.png"), png);
    const custom = "https://example.test/custom.png";
    const added = await f.command({ type: "workspace.add", path, icon: custom });
    const project = Project.parse(added.workspace);
    expect(project.defaultIcon).toMatch(/^data:image\/png;base64,/);
    expect(project.icon).toBe(custom);
    expect((await f.read({ op: "workspace.inspect", path })).result).toMatchObject({
      defaultIcon: project.defaultIcon,
    });
    const cleared = await f.command({
      type: "workspace.update",
      workspaceId: project.id,
      name: project.name,
      icon: null,
    });
    expect(cleared.workspace?.icon).toBeUndefined();
    expect(cleared.workspace?.defaultIcon).toBe(project.defaultIcon);
    expect(f.projects.catalog.recent(10)[0]?.defaultIcon).toBe(project.defaultIcon);
  } finally {
    await f.close();
  }
});

test("restart discovers a favicon for a previously registered project without waiting for a client row", async () => {
  const f = await projectFixture();
  let store: Store | undefined;
  let projects: Projects | undefined;
  try {
    const path = join(f.root, "previous");
    await mkdir(path);
    const project = Project.parse((await f.command({ type: "workspace.add", path })).workspace);
    await writeFile(
      join(path, "favicon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#f00" d="M0 0h16v16H0z"/></svg>',
    );
    await f.projects.close();
    await f.store.close();
    store = new Store(join(f.root, "events.sqlite"));
    projects = new Projects(store, () => 2000, { home: f.root, roots: async () => [f.root] });
    await projects.ready;
    expect(projects.catalog.get(project.id).defaultIcon).toMatch(/^data:image\/png;base64,/);
    expect(store.getWorkspace(project.id)?.defaultIcon).toBe(
      projects.catalog.get(project.id).defaultIcon,
    );
  } finally {
    await projects?.close();
    await store?.close();
    await f.close();
  }
});

test("unsafe or oversized favicon candidates and symlinks do not expose bytes or prevent registration", async () => {
  const f = await projectFixture();
  try {
    const outside = join(f.root, "outside.png");
    await writeFile(outside, png);
    for (const [name, content] of [
      [
        "remote",
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/private"/></svg>',
      ],
      [
        "entities",
        '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg>&secret;</svg>',
      ],
      ["script", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ["large", "x".repeat(96_001)],
      ["binary", "not an image"],
    ]) {
      if (name === undefined) throw new Error("Missing fixture name");
      const path = join(f.root, name);
      await mkdir(path);
      await writeFile(join(path, "favicon.svg"), content ?? "");
      const added = await f.command({ type: "workspace.add", path });
      expect(added.ok).toBe(true);
      expect(added.workspace?.defaultIcon).toBeUndefined();
    }
    const path = join(f.root, "linked");
    await mkdir(path);
    await symlink(outside, join(path, "favicon.png"));
    expect(await f.command({ type: "workspace.add", path })).toMatchObject({ ok: true });
    expect(
      f.projects.catalog.recent(10).find((project) => project.path === path)?.defaultIcon,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a malformed ICO falls through to a valid sibling PNG", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "broken-ico");
    await mkdir(path);
    const ico = Buffer.alloc(23);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(1, 4);
    ico[6] = 1;
    ico[7] = 1;
    ico.writeUInt32LE(1, 14);
    ico.writeUInt32LE(22, 18);
    ico[22] = 255;
    await writeFile(join(path, "favicon.ico"), ico);
    await writeFile(join(path, "favicon.png"), png);
    const added = await f.command({ type: "workspace.add", path });
    expect(added.workspace?.defaultIcon).toMatch(/^data:image\/png;base64,/);
  } finally {
    await f.close();
  }
});

test("temporary decoder unavailability preserves the persisted default and retries discovery", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "decoder-retry");
    await mkdir(path);
    await writeFile(join(path, "favicon.png"), png);
    const project = Project.parse((await f.command({ type: "workspace.add", path })).workspace);
    const favicon = await import("./project-favicon.ts");
    const spy = vi.spyOn(favicon, "discoverProjectFavicon").mockResolvedValueOnce(undefined);
    try {
      const edited = await f.command({
        type: "workspace.update",
        workspaceId: project.id,
        name: "Edited",
      });
      expect(edited.workspace?.defaultIcon).toBe(project.defaultIcon);
      expect(f.store.getWorkspace(project.id)?.defaultIcon).toBe(project.defaultIcon);
    } finally {
      spy.mockRestore();
    }
    const edited = await f.command({
      type: "workspace.update",
      workspaceId: project.id,
      name: "Retry",
    });
    expect(edited.workspace?.defaultIcon).toBe(project.defaultIcon);
  } finally {
    await f.close();
  }
});

test("decoder saturation reports transient unavailability and the next discovery succeeds", async () => {
  const f = await projectFixture();
  const { PinnedDirectory } = await import("@ace/workspace");
  const { discoverProjectFavicon } = await import("./project-favicon.ts");
  let directory: Awaited<ReturnType<typeof PinnedDirectory.open>> | undefined;
  try {
    const path = join(f.root, "decoder-bounded");
    await mkdir(path);
    await writeFile(join(path, "favicon.png"), png);
    directory = await PinnedDirectory.open(path);
    const root = directory;
    const icons = await Promise.all(Array.from({ length: 12 }, () => discoverProjectFavicon(root)));
    expect(icons.some((icon) => icon === undefined)).toBe(true);
    expect(icons.filter((icon) => icon === null)).toHaveLength(0);
    expect(await discoverProjectFavicon(root)).toMatch(/^data:image\/png;base64,/);
  } finally {
    await directory?.close();
    await f.close();
  }
});
