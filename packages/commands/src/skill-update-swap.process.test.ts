import { afterEach, expect, test } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  apply,
  demo,
  errorCode,
  installed,
  installedHash,
  lock,
  prepare,
  updated,
  updateHome,
  upstreamHash,
  v1,
} from "./skill-update-fixture.ts";
import type { RecoveryScheduler } from "./recovery-loop.ts";

// Windows has no atomic exchange: updates move folders with no-replace renames under the journal
// (ADR 0103, Windows). Every case here runs only on Windows.
const windows = test.runIf(process.platform === "win32");
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
/** Apply in a child process and kill it at the `count`th open of `pause` (`-` suffix: prefix). */
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

windows("Windows update apply swaps the folder in and records the new hash", async () => {
  const h = await home();
  const library = h.library();
  const entry = await demo(library);
  const review = await prepare(library, entry);
  expect(errorCode(await apply(library, entry, review))).toBe("skill");
  expect(await h.folder()).toEqual(updated);
  expect(JSON.parse(await readFile(h.lockPath, "utf8")).skills.demo.skillFolderHash).toBe(
    upstreamHash,
  );
});

windows("Windows update apply puts the original back when the lock can't be written", async () => {
  const h = await home();
  const library = h.library();
  const entry = await demo(library);
  const review = await prepare(library, entry);
  // A read-only lock file stays readable, but Windows refuses to replace it.
  await chmod(h.lockPath, 0o444);
  const result = await apply(library, entry, review);
  await chmod(h.lockPath, 0o644);
  expect(errorCode(result)).toBe("update_failed");
  expect(result.kind === "error" && result.message).toContain("skills lock file");
  expect(await h.folder()).toEqual(installed);
  expect(await readFile(h.lockPath, "utf8")).toBe(lock(installedHash));
});

windows("Windows update apply recovers after a crash between renames", async () => {
  // Killed right after the original moved to its backup name: the name is empty.
  const aside = await home();
  await crashApply(aside, ".demo.ace-old-", 1);
  await aside.library().start();
  expect(await aside.folder()).toEqual(installed);
  expect(await readFile(aside.lockPath, "utf8")).toBe(lock(installedHash));
  // Killed right after the replacement moved in, before the lock: recovery swaps them back.
  const swapped = await home();
  await crashApply(swapped, "demo", 2);
  await swapped.library().start();
  expect(await swapped.folder()).toEqual(installed);
  expect(await readFile(swapped.lockPath, "utf8")).toBe(lock(installedHash));
});

function manualSchedule() {
  const tasks: (() => Promise<boolean>)[] = [];
  const schedule: RecoveryScheduler = (run) => {
    tasks.push(run);
    return () => tasks.splice(tasks.indexOf(run), 1);
  };
  return { schedule, tasks };
}

windows(
  "Windows a restore blocked by an open file keeps both folders, and the next start finishes",
  async () => {
    const h = await home();
    await crashApply(h, "demo", 2);
    // Windows refuses to rename a folder while a file inside it is open.
    const held = await open(join(h.skills, "demo", "notes.md"), "r");
    const reports: string[] = [];
    try {
      await h.library({ report: (message) => reports.push(message) }).start();
    } finally {
      await held.close();
    }
    const folder = await h.folder();
    expect(folder["demo/SKILL.md"]).toBe(updated["demo/SKILL.md"]);
    expect(Object.entries(folder).some(([path, text]) => path.startsWith(".") && text === v1)).toBe(
      true,
    );
    expect(reports).toHaveLength(1);
    await h.library({ data: "data" }).start();
    expect(await h.folder()).toEqual(installed);
  },
);

windows(
  "Windows a skills lock that can't be opened is logged with its cause and recovery retries",
  async () => {
    const h = await home();
    await crashApply(h, ".demo.ace-old-", 1);
    // A folder where the lock database belongs: opening it fails until it's gone.
    const lockDatabase = join(h.home, ".agents", ".ace-skills.sqlite");
    await rm(lockDatabase, { force: true });
    await mkdir(lockDatabase);
    const reports: string[] = [];
    const retries = manualSchedule();
    await h
      .library({
        schedule: retries.schedule,
        report: (message, detail) => reports.push(`${message}: ${detail}`),
      })
      .start();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/^Skill update recovery will retry: .+/);
    expect(await h.folder()).not.toEqual(installed);
    await rm(lockDatabase, { recursive: true });
    expect(await retries.tasks[0]?.()).toBe(true);
    expect(await h.folder()).toEqual(installed);
  },
);

windows(
  "Windows a skill folder that can't be opened keeps its journal, and a later start finishes",
  async () => {
    const h = await home();
    await crashApply(h, ".demo.ace-old-", 1);
    // Deny everyone listing and reading the skill root, the way chmod 000 does on POSIX.
    execFileSync("icacls", [h.skills, "/deny", "*S-1-1-0:(RX)"], { stdio: "ignore" });
    const reports: string[] = [];
    try {
      await h.library({ report: (message) => reports.push(message) }).start();
    } finally {
      execFileSync("icacls", [h.skills, "/remove:d", "*S-1-1-0"], { stdio: "ignore" });
    }
    expect(reports).toEqual(["Skill folder of an interrupted update can't be opened yet"]);
    await h.library().start();
    expect(await h.folder()).toEqual(installed);
  },
);
