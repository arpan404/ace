import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { testHomeEnvironment } from "./test-home-environment.ts";
import type { TestHomeContext } from "./test-home-global-setup.ts";

const execute = promisify(execFile);

/** The empty repository Git fixtures copy, without the full process suite's bundle builds. */
export default async function setup(project: TestProject) {
  const context: TestHomeContext = project.getProvidedContext();
  const directory = await mkdtemp(join(context.testHomeRoot, "ace-git-tests-"));
  const gitTemplate = join(directory, "git-template");
  try {
    const env = testHomeEnvironment(
      join(directory, "home"),
      context.testRealHome,
      process.env,
      context.enclosingRepository?.checkouts,
    );
    await execute("git", ["init", "-b", "main", gitTemplate], {
      env,
      timeout: PROCESS_TEST_TIMEOUT,
    });
    await appendFile(
      join(gitTemplate, ".git/config"),
      "\n[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n",
    );
    project.provide("gitTemplate", gitTemplate);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(directory, { recursive: true, force: true });
}
