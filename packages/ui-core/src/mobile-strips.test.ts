import { expect, test } from "vitest";
import {
  approvalStripLine,
  holdStripLead,
  leftRunningStripLine,
  notSentStripLine,
  questionStripLine,
} from "./mobile-strips.ts";

const copy = {
  command: undefined,
  code: undefined,
  files: [] as string[],
  title: "Use the browser",
};

test("an approval says who wants what in one sentence, with the command alone under it", () => {
  expect(
    approvalStripLine({ ...copy, command: "bun run test\n--watch" }, undefined, "Claude", "claude"),
  ).toEqual({
    lead: { provider: "claude" },
    sentence: "Claude wants to run a command",
    payload: "bun run test",
    detail: "",
  });
});

test("a file request names how many files and shows the first path", () => {
  const line = approvalStripLine(
    copy,
    { paths: ["src/a.ts", "src/b.ts"], access: "write" },
    "Codex",
    "codex",
  );
  expect([line.sentence, line.payload]).toEqual(["Codex wants to edit 2 files", "src/a.ts"]);
  expect(
    approvalStripLine(copy, { paths: ["notes.md"], access: "read" }, "Codex", "codex").sentence,
  ).toBe("Codex wants to read 1 file");
});

test("any other approval says it wants approval and keeps the request's own title as prose", () => {
  expect(approvalStripLine(copy, undefined, "Claude", "claude")).toMatchObject({
    sentence: "Claude wants approval",
    payload: "",
    detail: "Use the browser",
  });
});

test("questions say how many and show the first one", () => {
  expect(questionStripLine(["Which region?"], "Claude", "claude").sentence).toBe(
    "Claude has a question",
  );
  expect(questionStripLine(["Which region?", "How many?"], "Claude", "claude")).toMatchObject({
    sentence: "Claude has 2 questions",
    detail: "Which region?",
  });
});

test("holds lead with the row's own icon for their state", () => {
  expect(holdStripLead("limit")).toEqual({ icon: "limited", tone: "limited" });
  expect(holdStripLead("restart")).toEqual({ icon: "failed", tone: "failed" });
  expect(holdStripLead("paused")).toEqual({ icon: "waiting", tone: "waiting" });
});

test("a message that didn't go says why once, with its opening words under it", () => {
  expect(notSentStripLine("Not sent · The daemon restarted", "Fix it\nplease")).toMatchObject({
    sentence: "Not sent · The daemon restarted",
    detail: "Fix it",
  });
  expect(notSentStripLine("", "Hi").sentence).toBe("Not sent");
});

test("commands a stopped turn left running show with their command, only once nothing else works", () => {
  expect(
    leftRunningStripLine({ over: true, subagents: 0, commands: ["bun run dev"] }),
  ).toMatchObject({
    lead: { icon: "background", tone: "background" },
    sentence: "Running",
    payload: "bun run dev",
  });
  expect(leftRunningStripLine({ over: true, subagents: 0, commands: ["a", "b"] })?.sentence).toBe(
    "Running 2 commands",
  );
  expect(leftRunningStripLine({ over: false, subagents: 0, commands: ["a"] })).toBeUndefined();
  expect(leftRunningStripLine({ over: true, subagents: 1, commands: ["a"] })).toBeUndefined();
});
