import { ThreadId, WorkspaceId } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  openPastSession,
  pastSessionProblems,
  type PastSessionPorts,
  type PastSessionAction,
} from "./past-sessions.ts";

const thread = ThreadId.parse("past-1");
const session = { sourceId: "codex:1", workspaceId: WorkspaceId.parse("ace") };

/** A machine that answers as told, keeping what it was asked to continue. */
function machine(answers: { imports?: boolean; continues?: boolean; fails?: boolean } = {}) {
  const continued: unknown[] = [];
  const ports: PastSessionPorts = {
    importSession: async (request) => {
      if (answers.fails) throw new Error("socket closed");
      expect(request).toEqual({ type: "history.import", ...session });
      return answers.imports === false
        ? { status: "unsupported" }
        : { status: "imported", threadId: thread };
    },
    continueSession: async (request) => {
      continued.push(request);
      return answers.continues === false
        ? { status: "unsupported" }
        : { status: "continued", threadId: thread };
    },
  };
  return {
    ports,
    continued,
    open: (action: PastSessionAction) => openPastSession(ports, session, action),
  };
}

test("Continue imports, then resumes that thread in its provider with nothing sent, then opens it", async () => {
  const { open, continued } = machine();
  expect(await open("continue")).toEqual({ threadId: thread, problem: null });
  expect(continued).toEqual([
    { type: "history.continue", threadId: thread, mode: "resume", input: [], delivery: "queue" },
  ]);
});

test("Import opens the imported thread and never resumes it", async () => {
  const { open, continued } = machine();
  expect(await open("import")).toEqual({ threadId: thread, problem: null });
  expect(continued).toEqual([]);
});

test.each([
  {
    case: "a session that can't be imported is never continued",
    answers: { imports: false },
    problem: pastSessionProblems.notImported,
    resumes: 0,
  },
  {
    case: "a session imported but not resumed isn't opened, so Import stays the way to read it",
    answers: { continues: false },
    problem: pastSessionProblems.notContinued,
    resumes: 1,
  },
  {
    case: "a machine that doesn't answer opens nothing",
    answers: { fails: true },
    problem: pastSessionProblems.notOpened,
    resumes: 0,
  },
])("$case", async ({ answers, problem, resumes }) => {
  const { open, continued } = machine(answers);
  expect(await open("continue")).toEqual({ threadId: null, problem });
  expect(continued).toHaveLength(resumes);
});
