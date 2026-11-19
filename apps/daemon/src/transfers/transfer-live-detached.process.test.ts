/*
 * A live move (ADR 0191) of a checkout whose HEAD changes between the bulk and the stop: two real
 * daemons over their pinned link and real Git, because the defect is in what the bulk bundle
 * carries and what the target asks of it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { continueOn, op, workingThread } from "./transfer-live-support.ts";
import { git, transferMachines } from "./transfer-test-support.ts";

it("lands a checkout that was detached when the bulk left and on a new branch at the stop", async () => {
  let moveOn: (() => Promise<void>) | undefined;
  const m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      // Once the bulk is on its way, the agent makes a branch and commits to it.
      if (op(route) === "chunk:code" && moveOn) {
        const run = moveOn;
        moveOn = undefined;
        await run();
      }
      return inner(profile, route, options);
    },
  });
  // No origin, so the bulk is the whole repository as a bundle, cut at the detached HEAD.
  const { path, threadId } = await workingThread(m, async (checkout) => {
    await git(checkout, "remote", "remove", "origin");
    await git(checkout, "checkout", "--quiet", "--detach");
  });
  moveOn = async () => {
    await git(path, "checkout", "--quiet", "-b", "feature");
    await writeFile(join(path, "feature.txt"), "made after the bulk\n");
    await git(path, "add", "feature.txt");
    await git(path, "commit", "--quiet", "-m", "feature work");
  };
  await continueOn(m, threadId);
  const transfer = await m.settled();
  expect(transfer.error).toBeUndefined();
  expect(transfer).toMatchObject({
    phase: "completed",
    method: "bundle",
    result: { branch: "feature" },
  });
  const landed = transfer.result?.path ?? "";
  expect(await readFile(join(landed, "feature.txt"), "utf8")).toBe("made after the bulk\n");
  expect(await git(landed, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
});
