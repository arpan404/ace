import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ParcelFiles } from "./files.ts";

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
function place() {
  const root = mkdtempSync(join(tmpdir(), "ace-parcel-files-"));
  made.push(root);
  const project = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  return { files: new ParcelFiles(join(root, "data")), project, outside };
}
/** A parcel staged from text and placed as a delivered one, as an arrival leaves it. */
async function delivered(files: ParcelFiles, id: string, text: string) {
  const staged = await files.stage(id, { text });
  const bytes = await files.readOut(id, 0, staged.size);
  await files.append(id, 0, bytes);
  await files.finish(id, "note.txt", staged.size, staged.sha256);
}

it("a file is sent only from inside the project, never through a link leading out", async () => {
  const { files, project, outside } = place();
  writeFileSync(join(outside, "secret"), "key");
  symlinkSync(join(outside, "secret"), join(project, "link"));
  await expect(files.stage("pcl-a", { project, path: "link" })).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(files.stage("pcl-b", { project, path: "../outside/secret" })).rejects.toMatchObject({
    code: "invalid",
  });
});

it("a named pipe in the project is refused at once instead of blocking the daemon", async () => {
  const { files, project } = place();
  execFileSync("mkfifo", [join(project, "pipe")]);
  await expect(files.stage("pcl-c", { project, path: "pipe" })).rejects.toMatchObject({
    code: "invalid",
  });
});

it("bytes that don't match the parcel's SHA-256 are never placed", async () => {
  const { files } = place();
  const staged = await files.stage("pcl-d", { text: "hello" });
  await files.append("pcl-d", 0, Buffer.from("hellp"));
  await expect(files.finish("pcl-d", "x.txt", staged.size, staged.sha256)).rejects.toMatchObject({
    code: "corrupt",
  });
  expect(existsSync(files.placed("pcl-d", "x.txt"))).toBe(false);
});

it("an empty parcel arrives whole without a chunk", async () => {
  const { files } = place();
  const staged = await files.stage("pcl-e", { text: "" });
  expect(staged.size).toBe(0);
  const path = await files.finish("pcl-e", "empty.txt", 0, staged.sha256);
  expect(readFileSync(path, "utf8")).toBe("");
});

it("saveAs makes nothing outside the project through a linked folder and never replaces a file", async () => {
  const { files, project, outside } = place();
  await delivered(files, "pcl-f", "data");
  symlinkSync(outside, join(project, "out"));
  await expect(files.saveAs("pcl-f", "note.txt", project, "out/new/x.txt")).rejects.toMatchObject({
    code: "invalid",
  });
  expect(existsSync(join(outside, "new"))).toBe(false);
  const saved = await files.saveAs("pcl-f", "note.txt", project, "inputs/x.txt");
  expect(readFileSync(saved, "utf8")).toBe("data");
  writeFileSync(join(project, "inputs", "y.txt"), "mine");
  await expect(files.saveAs("pcl-f", "note.txt", project, "inputs/y.txt")).rejects.toMatchObject({
    code: "exists",
  });
  expect(readFileSync(join(project, "inputs", "y.txt"), "utf8")).toBe("mine");
});

it("saveAs refuses a folder that only leads into .git through a link", async () => {
  const { files, project } = place();
  await delivered(files, "pcl-g", "#!/bin/sh");
  mkdirSync(join(project, ".git", "hooks"), { recursive: true });
  symlinkSync(join(project, ".git"), join(project, "docs"));
  await expect(
    files.saveAs("pcl-g", "note.txt", project, "docs/hooks/pre-commit"),
  ).rejects.toMatchObject({
    code: "invalid",
  });
  expect(existsSync(join(project, ".git", "hooks", "pre-commit"))).toBe(false);
});
