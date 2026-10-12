import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { findExecutable } from "@ace/provider-kit/discovery";
import { invoke } from "./cli-test-support.ts";

for (const operation of ["exec", "apply"] as const)
  test(`cloud ${operation} retains its generated retry key when fresh and cached receipt output fails`, async ({
    skip,
  }) => {
    if (!(await findExecutable("jq"))) skip();
    const home = await mkdtemp(join(tmpdir(), "ace-cli-cloud-output-"));
    try {
      const calls = join(home, "calls.jsonl");
      await writeFile(
        join(home, "codex"),
        `#!${process.execPath}\nconst fs = require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('synthetic-cloud-task');`,
        { mode: 0o700 },
      );
      const env = { PATH: `${home}${delimiter}${process.env.PATH ?? ""}` };
      const args = [
        "cloud",
        "codex",
        operation,
        ...(operation === "exec"
          ? ["--env", "synthetic-env", "Synthetic prompt"]
          : ["synthetic-task"]),
      ];
      const filter = ["--jq", 'error("output failed")', "--json"];
      const first = await invoke(home, [...args, ...filter], "", env);
      expect(first.code, first.stderr).toBe(5);
      const evidence = z
        .object({
          status: z.literal("uncertain"),
          admission: z.object({
            provider: z.literal("codex"),
            operation: z.literal(operation),
            idempotencyKey: z.string().min(1),
            stdout: z.literal("synthetic-cloud-task\n"),
          }),
        })
        .parse(JSON.parse(first.stdout)).admission;
      const retryArgs = [...args, "--idempotency-key", evidence.idempotencyKey];
      const cachedFailure = await invoke(home, [...retryArgs, ...filter], "", env);
      expect(cachedFailure.code, cachedFailure.stderr).toBe(5);
      expect(JSON.parse(cachedFailure.stdout)).toMatchObject({
        status: "uncertain",
        admission: evidence,
      });
      const recovered = await invoke(home, [...retryArgs, "--json"], "", env);
      expect(recovered.code, recovered.stderr).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject(evidence);
      expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
