import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { projectFixture } from "./projects-test-support.ts";

test("healthy project roots keep search browse inspect add and create usable while a peer is unavailable", async () => {
  let configured: string[] = [];
  const f = await projectFixture({ roots: async () => configured });
  try {
    const healthy = join(f.root, "healthy");
    const peer = join(f.root, "peer");
    configured = [healthy, peer];
    await mkdir(healthy);
    await mkdir(peer);
    await mkdir(join(healthy, "healthy-project"));
    expect(
      (await f.read({ op: "fs.browse", path: healthy, limit: 100, showHidden: false })).result,
    ).toMatchObject({ kind: "directories", entries: [{ name: "healthy-project" }] });
    await rm(peer, { recursive: true });
    expect(
      (await f.read({ op: "fs.search", query: "healthy-project", limit: 100, showHidden: false }))
        .result,
    ).toMatchObject({ kind: "search", entries: [{ name: "healthy-project" }] });
    expect(
      (await f.read({ op: "fs.browse", path: healthy, limit: 100, showHidden: false })).result,
    ).toMatchObject({ kind: "directories", entries: [{ name: "healthy-project" }] });
    expect((await f.read({ op: "workspace.inspect", path: healthy })).result).toMatchObject({
      kind: "inspection",
      path: healthy,
    });
    expect(await f.command({ type: "workspace.add", path: healthy })).toMatchObject({
      ok: true,
      workspace: { path: healthy },
    });
    expect(
      await f.command({ type: "workspace.create", parent: healthy, name: "created" }),
    ).toMatchObject({ ok: true, workspace: { path: join(healthy, "created") } });
    expect(
      (await f.read({ op: "fs.browse", path: peer, limit: 100, showHidden: false })).result,
    ).toEqual({ kind: "error", code: "directory_unavailable" });
    await mkdir(peer);
    await mkdir(join(peer, "restored-project"));
    expect(
      (await f.read({ op: "fs.search", query: "restored-project", limit: 100, showHidden: false }))
        .result,
    ).toMatchObject({ kind: "search", entries: [{ name: "restored-project" }] });
    expect((await f.read({ op: "fs.home" })).result).toMatchObject({
      kind: "home",
      roots: [healthy, peer],
    });
  } finally {
    await f.close();
  }
});

test("all unavailable explicit project roots refuse requests without authorizing the default home", async () => {
  let configured: string[] = [];
  const f = await projectFixture({ roots: async () => configured });
  try {
    const peer = join(f.root, "peer");
    await mkdir(peer);
    configured = [peer];
    await rm(peer, { recursive: true });
    expect((await f.read({ op: "fs.home" })).result).toEqual({
      kind: "error",
      code: "directory_unavailable",
    });
    expect(
      (await f.read({ op: "fs.search", query: "", limit: 100, showHidden: false })).result,
    ).toEqual({ kind: "error", code: "directory_unavailable" });
    expect(await f.command({ type: "workspace.add", path: f.root })).toMatchObject({
      ok: false,
      error: "directory_unavailable",
    });
    await mkdir(peer);
    expect((await f.read({ op: "fs.home" })).result).toMatchObject({ kind: "home", roots: [peer] });
  } finally {
    await f.close();
  }
});
