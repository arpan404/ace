import { access, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { parseArgs } from "./cli/args.ts";
import { cleanCommand, type Confirmation } from "./cli/clean.ts";
import { connectCli } from "./cli/connection.ts";
import { CliFailure, exitCodes } from "./cli/output.ts";

/** Runs `ace clean --logs --json` on a terminal against a real daemon; `answer` is the person. */
async function cleanWithAnswer(answer: Confirmation["ask"]) {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const exitCode = process.exitCode;
  try {
    await mkdir(join(home, "logs"), { recursive: true });
    const log = join(home, "logs/ace.1.jsonl");
    await writeFile(log, "rotated");
    await utimes(log, 0, 0);
    f.h.clock.advance(30 * 86400000);
    const args = parseArgs(["clean", "--logs", "--json"]);
    const questions: string[] = [];
    const session = await connectCli(home, args);
    let outcome: number;
    try {
      process.exitCode = undefined;
      await cleanCommand(args, session.client, session.signal, {
        interactive: true,
        ask: (question, signal) => {
          questions.push(question);
          return answer(question, signal);
        },
      });
      outcome = Number(process.exitCode ?? 0);
    } catch (error) {
      if (!(error instanceof CliFailure)) throw error;
      outcome = exitCodes[error.outcome];
    } finally {
      await session.close();
    }
    const removed = await access(log).then(
      () => false,
      () => true,
    );
    return { outcome, questions, removed };
  } finally {
    process.exitCode = exitCode;
    await f.daemon.close();
  }
}

test("answering yes at the terminal prompt applies the reviewed plan", async () => {
  const run = await cleanWithAnswer(async () => true);
  expect(run.questions).toEqual([expect.stringMatching(/^Remove 1 item .*\[y\/N\] $/)]);
  expect(run.outcome).toBe(exitCodes.ok);
  expect(run.removed).toBe(true);
});

test("answering no at the terminal prompt refuses and removes nothing", async () => {
  const run = await cleanWithAnswer(async () => false);
  expect(run.questions).toHaveLength(1);
  expect(run.outcome).toBe(exitCodes.refused);
  expect(run.removed).toBe(false);
});

test("aborting at the terminal prompt refuses and removes nothing", async () => {
  const run = await cleanWithAnswer(async () => {
    throw new DOMException("The prompt was aborted", "AbortError");
  });
  expect(run.questions).toHaveLength(1);
  expect(run.outcome).toBe(exitCodes.refused);
  expect(run.removed).toBe(false);
});
