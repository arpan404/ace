import type { ModelChoice } from "@ace/ui-core";
import { expect, test } from "vitest";
import {
  continuationAttachmentProblem,
  continueInNewThread,
  TurnStillRunning,
} from "./continue-in-thread.ts";

const codex = { provider: "codex", model: "GPT-5 Codex" } as Pick<
  ModelChoice,
  "provider" | "model"
> as ModelChoice;

test("a new thread whose model reads only text refuses the message's images by name before sending", () => {
  const problem = continuationAttachmentProblem(
    [{ name: "replay.png" }, { name: "notes.txt", mimeType: "text/plain" }],
    codex,
    ["text"],
  );
  expect(problem).toContain("GPT-5 Codex doesn't read images");
  expect(problem).toContain("replay.png");
  expect(problem).not.toContain("notes.txt");
});

test("files reach a new thread whose model reads images, or reads text only when none are images", () => {
  expect(
    continuationAttachmentProblem([{ name: "replay.png", mimeType: "image/png" }], codex, [
      "text",
      "image",
    ]),
  ).toBeUndefined();
  expect(
    continuationAttachmentProblem([{ name: "report.pdf", mimeType: "application/pdf" }], codex, [
      "text",
    ]),
  ).toBeUndefined();
});

/**
 * A thread whose main agent finished `run-1` (on a usage limit, say) and, when `rootRunId` is
 * set, is mid-turn on it. Its subagents and background commands live in the same store but are
 * the daemon's to settle; the composer only reads the main agent's turns.
 */
function threadWith(rootRunId: string | null) {
  const items: Record<string, unknown> = {
    answer: { id: "answer", type: "message", role: "assistant", agentId: "root", runId: "run-1" },
    "child-answer": { id: "child-answer", type: "message", agentId: "child", runId: "run-child" },
  };
  const runs: Record<string, unknown> = {
    "run-1": { id: "run-1", agentId: "root", state: "failed", endedAt: 10 },
    "run-child": { id: "run-child", agentId: "child", state: "active" },
    ...(rootRunId ? { [rootRunId]: { id: rootRunId, agentId: "root", state: "active" } } : {}),
  };
  const store = {
    order: ["answer", "child-answer"],
    thread: { rootAgentId: "root", live: { rootRunId } },
    item: (id: string) => items[id],
    run: (id: string) => runs[id],
  };
  const forks: unknown[] = [];
  const request = {
    client: { thread: () => ({ store, release: () => {} }) },
    actions: {
      fork: async (_thread: unknown, fork: unknown) => {
        forks.push(fork);
        return "thread-continued";
      },
    },
    thread: { id: "thread-1", title: "Fix login" },
    choice: { provider: "claude", model: "Claude Opus" },
    modalities: ["text"],
    draft: {
      text: "Carry on",
      mentions: [],
      attachments: [],
      files: { local: [], outcomes: Promise.resolve([]), release: () => {} },
    },
  } as unknown as Parameters<typeof continueInNewThread>[0];
  return { request, forks };
}

test("a thread whose main turn ended continues in a new thread while its subagents still run", async () => {
  const { request, forks } = threadWith(null);
  await expect(continueInNewThread(request)).resolves.toBe("thread-continued");
  expect(forks).toEqual([
    expect.objectContaining({ point: { type: "turn", runId: "run-1" }, input: "Carry on" }),
  ]);
});

test("a main turn still running holds the continuation back with a way to stop it", async () => {
  const { request, forks } = threadWith("run-2");
  await expect(continueInNewThread(request)).rejects.toBeInstanceOf(TurnStillRunning);
  expect(forks).toEqual([]);
});
