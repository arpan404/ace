import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  SessionOpenError,
  sessionStoreBusy,
  sessionStoreUnusable,
} from "@ace/provider-kit/open-error";
import { assertCheckpointBudget, checkpointDirectory } from "./checkpoints.ts";
import { markStoreUnusable } from "./store-fence.ts";

/** The code the engine reads once the open failure has crossed the provider boundary. */
const engineCode = (error: unknown) =>
  new SessionOpenError("cursor session opening failed", markStoreUnusable(error)).code;

test.each([
  "SDK checkpoint exceeds its budget; use context handoff",
  "Cursor's saved session is too large to keep: SDK checkpoint exceeds its budget; use context handoff. ace continues this thread in a fresh session with its context.",
  "SDK recovery run inventory exceeds budget",
  "Unclaimed SDK checkpoint has orphaned or conflicting identity; use context handoff",
])("a saved session Cursor can't open again is reported as unusable: %s", (message) => {
  expect(engineCode(new Error(message))).toBe(sessionStoreUnusable);
});

test("an unverifiable history is unusable when its cause says the store is", () => {
  const error = new Error(
    "Cursor SDK history could not be verified. Your thread and queued message are preserved.",
    { cause: new Error("SDK checkpoint exceeds its budget; use context handoff") },
  );
  expect(engineCode(error)).toBe(sessionStoreUnusable);
});

test.each([
  "Cursor SDK requires separate SDK sign-in or launch-environment authentication",
  "Cursor SDK open failed; delivery may be uncertain. Inspect history before resending.",
  "Checkpoint changed during snapshot; reconcile before sending",
  "Unsafe SDK checkpoint entry; use explicit context handoff",
  "ENOSPC: no space left on device",
  "ace could not write Cursor's checkpoint: ENOSPC: no space left on device. Execution is fenced; preserve this thread and use explicit bounded context handoff.",
  // Momentary write pressure from an earlier build: never a reason to throw the session away.
  "ace could not write Cursor's checkpoint: SDK checkpoint reservation backlog exceeds budget. Execution is fenced; preserve this thread and use explicit bounded context handoff.",
  "SDK checkpoint quota is fenced",
])("a failure that may pass, or an unsafe store, keeps its own code: %s", (message) => {
  expect(engineCode(Object.assign(new Error(message), { code: "auth" }))).not.toBe(
    sessionStoreUnusable,
  );
});

test("a fresh session generation opens its own checkpoint folder and keeps the old one", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-store-generation-")));
  try {
    const old = checkpointDirectory(home, "thread-1");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "index.db"), "the old saved session");
    const fresh = checkpointDirectory(home, "thread-1", 1);
    expect(fresh).not.toBe(old);
    // The old folder is over this budget; the new generation starts empty beside it.
    await expect(assertCheckpointBudget(old, 8)).rejects.toThrow("exceeds");
    await expect(assertCheckpointBudget(fresh, 8)).resolves.toBeUndefined();
    expect(checkpointDirectory(home, "thread-1", 1)).toBe(fresh);
    expect(await readFile(join(old, "index.db"), "utf8")).toBe("the old saved session");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  "SQLITE_BUSY: database is locked. Preserve the checkpoint and inspect this thread before retrying. Cursor SDK open failed; delivery may be uncertain.",
  "SQLITE_LOCKED: database table is locked",
])("a store another writer holds is busy, which passes, not unusable: %s", (message) => {
  expect(engineCode(new Error(message))).toBe(sessionStoreBusy);
});
