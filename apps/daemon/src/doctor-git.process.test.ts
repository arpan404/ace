import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DoctorReport } from "@ace/diagnostics";

const execute = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "ace-git-doctor-"));
  homes.push(directory);
  return directory;
}
async function doctor(directory: string, path: string) {
  let output = "";
  try {
    output = (
      await execute(
        process.execPath,
        [fileURLToPath(new URL("./cli.ts", import.meta.url)), "doctor", "--json"],
        {
          timeout: 15_000,
          env: { ...process.env, ACE_HOME: join(directory, "data"), ACE_PORT: "0", PATH: path },
        },
      )
    ).stdout;
  } catch (error) {
    // Other machine checks may fail. Git's independent verdict is what this test guards.
    if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string")
      output = error.stdout;
    else throw error;
  }
  return DoctorReport.parse(JSON.parse(output)).checks.find((check) => check.id === "git");
}
it("doctor finds the installed system git even when Finder provides an empty PATH", async () => {
  expect(await doctor(await home(), "")).toMatchObject({
    status: "ok",
    message: expect.stringMatching(/^git version /),
  });
});
it("doctor accepts Apple Git's version suffix from an explicit minimal PATH installation", async () => {
  const directory = await home();
  await writeFile(
    join(directory, "git"),
    '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 99\nprintf "git version 2.50.1 (Apple Git-155)\\n"\n',
  );
  await chmod(join(directory, "git"), 0o700);
  expect(await doctor(directory, directory)).toMatchObject({
    status: "ok",
    message: "git version 2.50.1 (Apple Git-155)",
  });
});
it("doctor rejects unrelated version output instead of reporting a working git", async () => {
  const directory = await home();
  await writeFile(join(directory, "git"), '#!/bin/sh\nprintf "unrelated version 2.50.1\\n"\n');
  await chmod(join(directory, "git"), 0o700);
  expect(await doctor(directory, directory)).toMatchObject({ status: "fail" });
});
