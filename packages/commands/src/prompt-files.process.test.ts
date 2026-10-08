import { mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { WorkspaceId } from "@ace/protocol";
import { PromptFiles } from "./index.ts";

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-prompt-editor-")));
  const home = join(root, "home"),
    project = join(root, "project");
  await mkdir(home);
  await mkdir(project);
  let id = 0;
  const files = new PromptFiles({
    globalRoot: home,
    projectRoot: (key) => (key === "project" ? project : undefined),
    id: () => String(++id),
  });
  onTestFinished(async () => {
    files.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, project, files };
}
const global = { kind: "global" as const };
const project = { kind: "project" as const, workspaceId: WorkspaceId.parse("project") };

test("global and project prompts can be created, reopened and edited with their diagnostics", async () => {
  const { files, home, project: root } = await setup();
  const text = "---\nname: review\ndescription: Review this change\n---\nExplain the diff.";
  for (const scope of [global, project]) {
    const created = await files.request({
      op: "write",
      scope,
      name: "review.md",
      text,
      expectedRevision: null,
    });
    expect(created.kind).toBe("file");
  }
  const listed = await files.request({ op: "list", workspaceId: "project" });
  expect(listed.kind === "list" && listed.files.map((f) => [f.title, f.scope.kind])).toEqual([
    ["review", "global"],
    ["review", "project"],
  ]);
  const opened = await files.request({ op: "read", scope: project, name: "review.md" });
  if (opened.kind !== "file") throw new Error("Prompt did not open");
  const saved = await files.request({
    op: "write",
    scope: project,
    name: "review.md",
    text: "---\nname: [\n---\nRepair this.",
    expectedRevision: opened.revision,
  });
  expect(saved.kind === "file" && saved.file.diagnostics[0]?.message).toBe(
    "The settings at the top of this prompt have invalid syntax. Check the names, brackets and indentation.",
  );
  expect(await readFile(join(root, ".ace/prompts/review.md"), "utf8")).toContain("Repair this.");
  expect(await readFile(join(home, "prompts/review.md"), "utf8")).toBe(text);
});

test("a save refuses to overwrite a prompt changed by another editor", async () => {
  const { files, home } = await setup();
  await files.request({
    op: "write",
    scope: global,
    name: "note.md",
    text: "Original",
    expectedRevision: null,
  });
  const opened = await files.request({ op: "read", scope: global, name: "note.md" });
  if (opened.kind !== "file") throw new Error("Prompt did not open");
  await writeFile(join(home, "prompts/note.md"), "Someone else's edit");
  const result = await files.request({
    op: "write",
    scope: global,
    name: "note.md",
    text: "My stale edit",
    expectedRevision: opened.revision,
  });
  expect(result).toMatchObject({ kind: "error", code: "conflict" });
  expect(await readFile(join(home, "prompts/note.md"), "utf8")).toBe("Someone else's edit");
  expect(
    await files.request({
      op: "write",
      scope: global,
      name: "note.md",
      text: "New",
      expectedRevision: null,
    }),
  ).toMatchObject({ kind: "error", code: "conflict" });
});

test("prompt reads and writes cannot follow a project prompt-folder symlink", async () => {
  const { files, root, project: projectRoot } = await setup();
  const outside = join(root, "outside");
  await mkdir(outside);
  await mkdir(join(projectRoot, ".ace"));
  await writeFile(join(outside, "secret.md"), "Private fixture");
  await symlink(outside, join(projectRoot, ".ace/prompts"));
  expect(await files.request({ op: "read", scope: project, name: "secret.md" })).toMatchObject({
    kind: "error",
  });
  expect(
    await files.request({
      op: "write",
      scope: project,
      name: "new.md",
      text: "Intrusion",
      expectedRevision: null,
    }),
  ).toMatchObject({ kind: "error" });
  expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("Private fixture");
});

test("a prompt that is too large or has an invalid file name cannot be saved", async () => {
  const { files } = await setup();
  expect(
    await files.request({
      op: "write",
      scope: global,
      name: "../escape.md",
      text: "No",
      expectedRevision: null,
    }),
  ).toMatchObject({ kind: "error" });
  expect(
    await files.request({
      op: "write",
      scope: global,
      name: "large.md",
      text: "é".repeat(40000),
      expectedRevision: null,
    }),
  ).toMatchObject({ kind: "error", code: "limit" });
});

test("a prompt names the settings problem and becomes usable after it is edited", async () => {
  const { files } = await setup();
  for (const [name, text, reason] of [
    ["missing-close.md", "---\nname: review\nReview this.", "closing --- line"],
    ["invalid-value.md", "---\nprovider: made-up\n---\nReview this.", "unsupported value"],
  ]) {
    if (!name || !text || !reason) throw new Error("Missing fixture");
    const broken = await files.request({
      op: "write",
      scope: global,
      name,
      text,
      expectedRevision: null,
    });
    if (broken.kind !== "file") throw new Error("Prompt didn't open");
    expect(broken.file.diagnostics[0]?.message).toContain(reason);
    const saved = await files.request({
      op: "write",
      scope: global,
      name,
      text: "Review this.",
      expectedRevision: broken.revision,
    });
    expect(saved.kind === "file" && saved.file.diagnostics).toEqual([]);
  }
});
