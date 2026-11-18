import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceId } from "@ace/protocol";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { expect, onTestFinished, test } from "vitest";
import { readMarker, writeMarker } from "./project-marker.ts";
import { projectFixture } from "./projects-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";

async function folder() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-marker-")));
  const project = join(root, "app");
  await mkdir(join(project, ".ace"), { recursive: true });
  const held = PinnedDirectory.open(project);
  onTestFinished(async () => {
    await held.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, held, file: join(project, ".ace", "project.json") };
}

test("a marker of exactly the schema reads as its id and name", async () => {
  const f = await folder();
  await writeFile(f.file, JSON.stringify({ version: 1, id: P, name: "app" }));
  expect(await readMarker(f.held)).toEqual({ version: 1, id: P, name: "app" });
});

test("malformed, oversized and off-schema markers read as absent", async () => {
  const f = await folder();
  for (const text of [
    "{not json",
    JSON.stringify({ version: 2, id: P }),
    JSON.stringify({ version: 1, id: "not-a-uuid" }),
    JSON.stringify({ version: 1, id: "ABCDEF12-1111-4111-8111-111111111111" }),
    // Nothing else may ride along: no paths, hosts or credentials.
    JSON.stringify({ version: 1, id: P, path: "/home/someone" }),
    JSON.stringify({ version: 1, id: P, name: "x".repeat(5000) }),
  ]) {
    await writeFile(f.file, text);
    expect(await readMarker(f.held)).toBeUndefined();
  }
});

test("a symlinked marker or marker folder is never followed", async () => {
  const f = await folder();
  const outside = join(f.root, "elsewhere.json");
  await writeFile(outside, JSON.stringify({ version: 1, id: P }));
  await symlink(outside, f.file);
  expect(await readMarker(f.held)).toBeUndefined();
  await rm(join(f.project, ".ace"), { recursive: true });
  const real = join(f.root, "real-ace");
  await mkdir(real);
  await writeFile(join(real, "project.json"), JSON.stringify({ version: 1, id: P }));
  await symlink(real, join(f.project, ".ace"));
  expect(await readMarker(f.held)).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "a FIFO marker reads as absent at once, without waiting for a writer",
  async () => {
    const f = await folder();
    await execute("mkfifo", [f.file]);
    const started = performance.now();
    expect(await readMarker(f.held, 2_000)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  },
);

test("writing creates exactly the schema, leaves the same id alone and refuses another without asking", async () => {
  const f = await folder();
  await rm(join(f.project, ".ace"), { recursive: true });
  expect(await writeMarker(f.held, { version: 1, id: P, name: "app" }, false)).toBe("written");
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({ version: 1, id: P, name: "app" });
  expect(await writeMarker(f.held, { version: 1, id: P, name: "renamed" }, false)).toBe(
    "unchanged",
  );
  expect(await writeMarker(f.held, { version: 1, id: Q }, false)).toBe("marker_conflict");
  expect(JSON.parse(await readFile(f.file, "utf8")).id).toBe(P);
  expect(await writeMarker(f.held, { version: 1, id: Q }, true)).toBe("written");
  expect(JSON.parse(await readFile(f.file, "utf8")).id).toBe(Q);
});

test("a symlink where the marker goes is never written through", async () => {
  const f = await folder();
  const outside = join(f.root, "victim.txt");
  await writeFile(outside, "keep me\n");
  await symlink(outside, f.file);
  // Something is there that isn't a marker: said so, and nothing is written through it.
  expect(await writeMarker(f.held, { version: 1, id: P }, false)).toBe("marker_unreadable");
  expect(await readFile(outside, "utf8")).toBe("keep me\n");
});

test("a copied marker is reported on inspect and as a marked suggestion, and links nothing by itself", async () => {
  const f = await projectFixture({ identityId: () => Q });
  onTestFinished(() => f.close());
  const copy = join(f.root, "unrelated");
  await mkdir(join(copy, ".ace"), { recursive: true });
  await writeFile(join(copy, ".ace", "project.json"), JSON.stringify({ version: 1, id: P }));
  const inspected = await f.read({ op: "workspace.inspect", path: copy });
  expect(inspected.result).toMatchObject({ kind: "inspection", marker: { version: 1, id: P } });
  const added = await f.command({ type: "workspace.add", path: copy });
  // Added, it is its own project: the marker only suggested.
  expect(added.workspace?.identity).toMatchObject({ id: Q, source: "created" });
  const runtime = new WorkspaceRuntime(f.store, join(f.root, "data"), () => 1000);
  onTestFinished(() => runtime.close());
  const suggested = await runtime.read({
    type: "workspace.request",
    requestId: "suggest",
    operation: {
      op: "workspaces.identitySuggestions",
      remotes: [],
      subpath: "",
      identityId: P,
      limit: 32,
    },
  });
  expect(suggested.result).toEqual({
    kind: "identitySuggestions",
    suggestions: [
      { workspaceId: added.workspace?.id, shared: [], sameRemotes: false, marker: true },
    ],
    next: null,
  });
  // The person confirms: its source says the marker was why.
  const linked = await f.command({
    type: "workspace.identity.link",
    workspaceId: WorkspaceId.parse(added.workspace?.id),
    identityId: P,
    viaMarker: true,
  });
  expect(linked.workspace?.identity).toMatchObject({ id: P, source: "marker" });
});

test("Share identity with clones writes the project's marker, and asks before replacing another", async () => {
  const f = await projectFixture({ identityId: () => P });
  onTestFinished(() => f.close());
  const path = join(f.root, "shared");
  await mkdir(path);
  const added = await f.command({ type: "workspace.add", path });
  const workspaceId = WorkspaceId.parse(added.workspace?.id);
  expect(await f.command({ type: "workspace.identity.marker.write", workspaceId })).toMatchObject({
    ok: true,
  });
  expect(JSON.parse(await readFile(join(path, ".ace", "project.json"), "utf8"))).toEqual({
    version: 1,
    id: P,
    name: "shared",
  });
  await writeFile(join(path, ".ace", "project.json"), JSON.stringify({ version: 1, id: Q }));
  expect(await f.command({ type: "workspace.identity.marker.write", workspaceId })).toMatchObject({
    ok: false,
    error: "marker_conflict",
  });
  expect(
    await f.command({ type: "workspace.identity.marker.write", workspaceId, replace: true }),
  ).toMatchObject({ ok: true });
  expect(JSON.parse(await readFile(join(path, ".ace", "project.json"), "utf8")).id).toBe(P);
});

test("Share identity with clones says when what is there isn't a marker, and leaves a merged id's marker alone", async () => {
  const f = await projectFixture({ identityId: () => P });
  onTestFinished(() => f.close());
  const path = join(f.root, "odd");
  await mkdir(join(path, ".ace"), { recursive: true });
  await writeFile(join(path, ".ace", "project.json"), "my own notes\n");
  const added = await f.command({ type: "workspace.add", path });
  const workspaceId = WorkspaceId.parse(added.workspace?.id);
  expect(await f.command({ type: "workspace.identity.marker.write", workspaceId })).toMatchObject({
    ok: false,
    error: "marker_unreadable",
  });
  expect(await readFile(join(path, ".ace", "project.json"), "utf8")).toBe("my own notes\n");
  // A marker naming Q, which was merged into this project's P here, is this project's already.
  await writeFile(join(path, ".ace", "project.json"), JSON.stringify({ version: 1, id: Q }));
  await f.command({ type: "workspace.identity.merge", from: Q, into: P });
  expect(await f.command({ type: "workspace.identity.marker.write", workspaceId })).toMatchObject({
    ok: true,
  });
  expect(JSON.parse(await readFile(join(path, ".ace", "project.json"), "utf8")).id).toBe(Q);
});
