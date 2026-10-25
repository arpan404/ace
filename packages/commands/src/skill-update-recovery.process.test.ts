import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { openCommandChild, type OpenCommandChild } from "./posix.ts";
import {
  apply,
  demo,
  errorCode,
  installed,
  installedHash,
  lock,
  prepare,
  put,
  updated,
  updateHome,
  upstreamHash,
  v1,
} from "./skill-update-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function home() {
  const made = await updateHome();
  cleanups.push(made.close);
  return made;
}
type Home = Awaited<ReturnType<typeof home>>;

/**
 * Apply the update in a real child process and SIGKILL it at the `count`th descriptor open of
 * `pause` (a `-` suffix matches a prefix), the way a daemon dies mid-apply.
 */
async function crashApply(h: Home, pause: string, count: number) {
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "skill-update-crash.child.ts"),
      JSON.stringify({
        home: h.home,
        data: join(h.root, "data"),
        upstream: h.upstream,
        pause,
        count,
      }),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("paused")) resolve();
      if (output.includes("finished")) reject(new Error(`Child finished: ${output}`));
    });
    child.once("exit", () => reject(new Error(`Child exited early: ${output}`)));
  });
  child.kill("SIGKILL");
  await exited;
}
const hidden = (folder: Record<string, string>) =>
  Object.keys(folder).filter((path) => path.startsWith("."));
// Pause points in an apply: the original just moved to the backup; the replacement just moved in
// (lock not yet written); the lock written, backup not yet removed.
const movedAside = [".demo.ace-old-", 1] as const;
const swappedIn = ["demo", 2] as const;
const committed = [".demo.ace-old-", 3] as const;

test("a restart after a crash mid-swap puts the original back", async () => {
  const h = await home();
  await crashApply(h, ...movedAside);
  await h.library().start();
  expect(await h.folder()).toEqual(installed);
  expect(await readFile(h.lockPath, "utf8")).toBe(lock(installedHash));

  const g = await home();
  await crashApply(g, ...swappedIn);
  await g.library().start();
  expect(await g.folder()).toEqual(installed);
});

test("a restart after the lock recorded the update keeps it and drops the backup", async () => {
  const h = await home();
  await crashApply(h, ...committed);
  await h.library().start();
  expect(await h.folder()).toEqual(updated);
  expect(JSON.parse(await readFile(h.lockPath, "utf8")).skills.demo.skillFolderHash).toBe(
    upstreamHash,
  );
});

test("a folder the person reinstalled after a crash survives recovery, and the backup is kept", async () => {
  const h = await home();
  await crashApply(h, ...movedAside);
  await put(join(h.skills, "demo/SKILL.md"), "Reinstalled by hand.\n");
  const reports: string[] = [];
  await h.library({ report: (message) => reports.push(message) }).start();
  const folder = await h.folder();
  expect(folder["demo/SKILL.md"]).toBe("Reinstalled by hand.\n");
  // The original is still there for the person, nothing of it deleted.
  expect(
    Object.entries(folder).filter(([path, text]) => path.startsWith(".") && text === v1),
  ).toHaveLength(1);
  expect(reports).toHaveLength(1);
});

test("hidden folders without a journal are never touched, even if named like ace's", async () => {
  const h = await home();
  await put(join(h.skills, ".demo.ace-old-someone/SKILL.md"), "Not ace's.\n");
  await put(join(h.skills, ".demo.ace-update-someone/SKILL.md"), "Not ace's either.\n");
  await crashApply(h, ...movedAside);
  await h.library().start();
  expect(await h.folder()).toEqual({
    ...installed,
    ".demo.ace-old-someone/SKILL.md": "Not ace's.\n",
    ".demo.ace-update-someone/SKILL.md": "Not ace's either.\n",
  });
});

test("a restore that fails keeps the current folder and the backup, and the next start finishes", async () => {
  const h = await home();
  await crashApply(h, ...swappedIn);
  await chmod(h.skills, 0o555);
  const reports: string[] = [];
  await h.library({ report: (message) => reports.push(message) }).start();
  await chmod(h.skills, 0o755);
  const folder = await h.folder();
  expect(folder["demo/SKILL.md"]).toBe(updated["demo/SKILL.md"]);
  expect(hidden(folder).some((path) => folder[path] === v1)).toBe(true);
  expect(reports).toHaveLength(1);
  await h.library({ data: "data" }).start();
  expect(await h.folder()).toEqual(installed);
});

test("a folder replaced while the update was staging is moved back, not deleted", async () => {
  const h = await home();
  let armed = true;
  const openChild: OpenCommandChild = async (directory, name, flags) => {
    if (armed && name.startsWith(".demo.ace-update-")) {
      // Another program swaps in its own folder for demo.
      armed = false;
      await rename(join(h.skills, "demo"), join(h.root, "taken-away"));
      await put(join(h.skills, "demo/SKILL.md"), "Someone else's.\n");
    }
    return openCommandChild(directory, name, flags);
  };
  const library = h.library({ openChild });
  const entry = await demo(library);
  const review = await prepare(library, entry);
  expect(errorCode(await apply(library, entry, review))).toBe("conflict");
  expect(await h.folder()).toEqual({ "demo/SKILL.md": "Someone else's.\n" });
  expect(await readFile(join(h.root, "taken-away/SKILL.md"), "utf8")).toBe(v1);
});

/** Stops an apply at the `count`th open of an entry starting with `prefix`, until released. */
function gate(prefix: string, count: number) {
  const control = { armed: false, release: () => {}, paused: () => {} };
  const pausedAt = new Promise<void>((resolve) => (control.paused = resolve));
  const opened = new Promise<void>((resolve) => (control.release = resolve));
  let opens = 0;
  const openChild: OpenCommandChild = async (directory, name, flags) => {
    if (control.armed && name.startsWith(prefix) && ++opens === count) {
      control.armed = false;
      control.paused();
      await opened;
    }
    return openCommandChild(directory, name, flags);
  };
  cleanups.push(async () => control.release());
  return { control, pausedAt, openChild };
}

test("two aces applying at once take turns: the second sees the first's update as a change", async () => {
  const h = await home();
  // The second open of the staging folder: the first ace is filling it, demo still in place.
  const { control, pausedAt, openChild } = gate(".demo.ace-update-", 2);
  const first = h.library({ data: "first", openChild });
  const second = h.library({ data: "second" });
  const entry = await demo(first);
  const secondReview = await prepare(second, entry);
  const firstReview = await prepare(first, entry);
  control.armed = true;
  const firstApply = apply(first, entry, firstReview);
  await pausedAt;
  let secondSettled = false;
  const secondApply = apply(second, entry, secondReview).finally(() => (secondSettled = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(secondSettled).toBe(false);
  control.release();
  expect(errorCode(await firstApply)).toBe("skill");
  expect(errorCode(await secondApply)).toBe("conflict");
  expect(await h.folder()).toEqual(updated);
});

test("recovery waits for another ace's apply instead of undoing it", async () => {
  const h = await home();
  const { control, pausedAt, openChild } = gate(".demo.ace-old-", 1);
  // Both aces share one data directory here, so the second sees the first's journal.
  const first = h.library({ data: "shared", openChild });
  const entry = await demo(first);
  const review = await prepare(first, entry);
  control.armed = true;
  const applying = apply(first, entry, review);
  await pausedAt;
  await mkdir(join(h.root, "shared"), { recursive: true });
  let recovered = false;
  const recovering = h
    .library({ data: "shared" })
    .start()
    .finally(() => (recovered = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(recovered).toBe(false);
  control.release();
  expect(errorCode(await applying)).toBe("skill");
  await recovering;
  expect(await h.folder()).toEqual(updated);
  await rm(join(h.root, "shared"), { recursive: true, force: true });
});
