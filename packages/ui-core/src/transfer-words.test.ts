import { HostId, ThreadId, WorkspaceId, type Transfer } from "@ace/protocol";
import { expect, test } from "vitest";
import { doneWords, runningWords } from "./transfer-words.ts";
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
  expect(runningWords(moving({ stage: "stopping" }))).toBe("Stopping at a safe point");
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
