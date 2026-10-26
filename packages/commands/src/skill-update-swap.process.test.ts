import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
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
} from "./skill-update-fixture.ts";

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
