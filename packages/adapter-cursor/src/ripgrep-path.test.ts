import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { windowsArm64RipgrepPath } from "./ripgrep-path.ts";

let root: string;
let empty: string;
let ace: string;
let user: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-cursor-rg-"));
  empty = join(root, "empty");
  ace = join(root, "ace-bin");
  user = join(root, "user-bin");
  for (const folder of [empty, ace, user]) await mkdir(folder);
  await writeFile(join(ace, "rg.exe"), "");
  await writeFile(join(user, "rg.exe"), "");
});
afterEach(() => rm(root, { recursive: true, force: true }));

it("points the SDK at the first absolute PATH folder holding rg.exe on Windows ARM64", () => {
  // A relative entry would resolve inside the user's workspace, where the SDK host runs.
  const path = [".", "ace-bin", empty, ace, user].join(delimiter);
  expect(windowsArm64RipgrepPath({ Path: path }, "win32", "arm64")).toBe(join(ace, "rg.exe"));
});

it("keeps a ripgrep the user already pinned with an absolute path", () => {
  const env = { PATH: ace, CURSOR_RIPGREP_PATH: join(user, "rg.exe") };
  expect(windowsArm64RipgrepPath(env, "win32", "arm64")).toBeUndefined();
  const relative = { PATH: ace, CURSOR_RIPGREP_PATH: "rg.exe" };
  expect(windowsArm64RipgrepPath(relative, "win32", "arm64")).toBe(join(ace, "rg.exe"));
});

it("leaves the SDK's own helper lookup alone outside Windows ARM64 and when PATH has no rg.exe", () => {
  expect(windowsArm64RipgrepPath({ PATH: ace }, "win32", "x64")).toBeUndefined();
  expect(windowsArm64RipgrepPath({ PATH: ace }, "darwin", "arm64")).toBeUndefined();
  expect(windowsArm64RipgrepPath({ PATH: empty }, "win32", "arm64")).toBeUndefined();
  expect(windowsArm64RipgrepPath({}, "win32", "arm64")).toBeUndefined();
});
