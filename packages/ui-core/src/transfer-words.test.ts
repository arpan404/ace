import { HostId, ThreadId, WorkspaceId, type Transfer } from "@ace/protocol";
import { expect, test } from "vitest";
import { doneWords, refusalWords, runningWords } from "./transfer-words.ts";
import { continuedWords, threadTransferState } from "./transfers.ts";

type Result = NonNullable<Transfer["result"]>;

const opened = (result: Partial<Result>) =>
  doneWords({
    kind: "project",
    target: { hostId: HostId.parse("studio"), name: "Studio" },
    result: { workspaceId: WorkspaceId.parse("w"), path: "/p", ...result },
  });

test("a project sent again says how many of its files the copy there kept", () => {
  expect(opened({ keptFiles: 3 })).toBe("Opened on Studio · kept its own copy of 3 files");
  expect(opened({ keptFiles: 1, ignoredSkipped: 2 })).toBe(
    "Opened on Studio · kept its own copy of 1 file · kept its own copy of 2 ignored files",
  );
});

test("work that landed beside a busy checkout names the branch it is on", () => {
  expect(opened({ branch: "fix-login-from-mac", branchOnly: true })).toBe(
    "Opened on Studio on fix-login-from-mac",
  );
  expect(opened({ branch: "fix-login" })).toBe("Opened on Studio");
});

const moving = (live: NonNullable<Transfer["live"]>, more: Partial<Transfer> = {}): Transfer => ({
  transferId: "t",
  commandId: "c" as Transfer["commandId"],
  kind: "thread",
  workspaceId: WorkspaceId.parse("w"),
  target: { hostId: HostId.parse("studio"), name: "Studio" },
  phase: "sending",
  sentBytes: 312_000_000,
  totalBytes: 1_200_000_000,
  live,
  startedAt: 1,
  updatedAt: 1,
  ...more,
});

test("a working thread on its way says where the move stands, in one sentence", () => {
  expect(runningWords(moving({ stage: "readying" }))).toBe(
    "Getting Studio ready · 312 MB of 1.2 GB",
  );
  expect(runningWords(moving({ stage: "stopping" }))).toBe("Stopping the work here");
  expect(runningWords(moving({ stage: "handing" }, { phase: "importing" }))).toBe(
    "Moving to Studio",
  );
});

test("a thread that moved says so, not that it was continued", () => {
  expect(doneWords(moving({ stage: "moved" }, { phase: "completed" }))).toBe("Moved to Studio");
});

test("the thread line names where moved work went, and opens the thread there", () => {
  const to = { hostId: HostId.parse("studio"), name: "Studio", threadId: ThreadId.parse("there") };
  const state = threadTransferState(undefined, {}, false, { state: "moved", to });
  if (!state || state.kind === "transfer") throw new Error("no line");
  expect(continuedWords(state)).toEqual({
    words: "Moved to Studio",
    where: to,
  });
});

test("a move that stopped before handing over says the thread stayed here, words or none", () => {
  expect(refusalWords({ code: "process_still_running" }, "Studio")).toBe(
    "Something in the thread didn't stop, so it stayed here. Stop it, then try again.",
  );
  expect(refusalWords({ code: "remote_child_unconfirmed" }, "Studio")).toBe(
    "A subagent on another machine never confirmed it stopped, so the thread stayed here.",
  );
  expect(refusalWords({ code: "target_too_old" }, "Studio")).toBe(
    "Studio runs an older ace that can't take a working thread. Let it finish here, or update ace there.",
  );
  // An upgraded machine still indexing its transfers refuses a move for a moment.
  expect(refusalWords({ code: "transfers_unavailable" }, "Studio")).toBe(
    "Transfers aren't ready on this machine yet. Try again in a moment.",
  );
  // The daemon's own sentence wins: it names the process that kept running.
  expect(
    refusalWords(
      {
        code: "process_still_running",
        detail: "npm run dev didn't stop, so the thread stayed here.",
      },
      "Studio",
    ),
  ).toBe("npm run dev didn't stop, so the thread stayed here.");
});
