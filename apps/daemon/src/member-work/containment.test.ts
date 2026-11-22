import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { systemdSliceContainment, treeSlice, type CommandRunner } from "./containment.ts";

/*
 * A member tree's kill counts only on positive word (ADR 0209 §7.3): systemd saying nothing of
 * the tree's slice runs, or its cgroup reading empty. A cgroup it can't read is not empty.
 * systemd is stood in for at its command line; the cgroup files are real files.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cgroups() {
  const dir = mkdtempSync(join(tmpdir(), "ace-cgroups-"));
  dirs.push(dir);
  return dir;
}
const shows =
  (stdout: string, code = 0): CommandRunner =>
  async () => ({ code, stdout, stderr: "" });

it("a tree's cgroup that can't be read is never confirmed empty", async () => {
  const root = cgroups();
  const containment = systemdSliceContainment({
    instance: "home",
    cgroupRoot: root,
    settleMs: 0,
    run: shows("LoadState=loaded\nActiveState=active\nControlGroup=/user.slice/ace-member.slice\n"),
  });
  expect(await containment.kill("user_mia", "t_one")).toBe(false);
});

it("systemd that can't be asked confirms nothing", async () => {
  const containment = systemdSliceContainment({
    instance: "home",
    cgroupRoot: cgroups(),
    run: shows("", 1),
  });
  expect(await containment.kill("user_mia", "t_one")).toBe(false);
});

it("an empty cgroup, or a slice systemd never made, is confirmed", async () => {
  const root = cgroups();
  mkdirSync(join(root, "slice"), { recursive: true });
  writeFileSync(join(root, "slice", "cgroup.events"), "populated 0\nfrozen 0\n");
  const empty = systemdSliceContainment({
    instance: "home",
    cgroupRoot: root,
    run: shows("LoadState=loaded\nActiveState=active\nControlGroup=/slice\n"),
  });
  expect(await empty.kill("user_mia", "t_one")).toBe(true);
  const never = systemdSliceContainment({
    instance: "home",
    cgroupRoot: root,
    run: shows("LoadState=not-found\nActiveState=inactive\nControlGroup=\n"),
  });
  expect(await never.kill("user_mia", "t_one")).toBe(true);
  // A loaded, active unit with no cgroup named is no positive word.
  const odd = systemdSliceContainment({
    instance: "home",
    cgroupRoot: root,
    run: shows("LoadState=loaded\nActiveState=active\nControlGroup=\n"),
  });
  expect(await odd.kill("user_mia", "t_one")).toBe(false);
});

it("each of a member's trees has a slice of its own, inside the member's", () => {
  const one = treeSlice("home", "user_mia", "t_one");
  const two = treeSlice("home", "user_mia", "t_two");
  expect(one).not.toBe(two);
  expect(one.split("-").slice(0, 3)).toEqual(two.split("-").slice(0, 3));
  expect(treeSlice("other-home", "user_mia", "t_one")).not.toBe(one);
});
