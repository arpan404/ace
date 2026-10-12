import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { secureDataDir } from "../local-files.ts";
import { type Args, timeoutMs } from "./args.ts";
import { cloudPlan } from "./cloud-plan.ts";
import { key } from "./mutations.ts";
import { prompt, result, mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
const Receipt = z.object({
  provider: z.literal("codex"),
  operation: z.string(),
  status: z.enum(["ok", "failed"]),
  exitCode: z.number().int(),
  stdout: z.string().max(2_097_152),
  idempotencyKey: z.string().optional(),
});
export async function cloudCommand(args: Args, home: string) {
  const native = cloudPlan(args, args.words[2] === "exec" ? await prompt(args, 3) : undefined);
  const mutates = args.words[2] === "exec" || args.words[2] === "apply";
  secureDataDir(home);
  const db = new DatabaseSync(join(home, "cli-cloud.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT)",
  );
  const id = mutates ? key(args) : randomUUID();
  const input = createHash("sha256")
    .update(process.cwd())
    .update(JSON.stringify(native))
    .digest("hex");
  try {
    if (mutates) {
      let fresh = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT input,result FROM receipts WHERE id=?").get(id);
        if (!existing) {
          db.prepare("INSERT INTO receipts VALUES (?,?,NULL)").run(id, input);
          fresh = true;
        } else {
          if (existing.input !== input)
            throw new CliFailure("refused", "Cloud idempotency key was used with different input");
          if (typeof existing.result !== "string")
            throw new CliFailure(
              "uncertain",
              `Previous cloud invocation is uncertain; inspect codex cloud list before submitting new work. Key: ${id}`,
              { provider: "codex", operation: args.words[2], idempotencyKey: id },
            );
          const receipt = Receipt.parse(JSON.parse(existing.result));
          db.exec("COMMIT");
          return mutationResult(args, receipt, receipt.status);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (!fresh) throw new CliFailure("uncertain", "Cloud admission unavailable");
    }
    const child = spawnTextSupervised({
      command: "codex",
      args: native,
      cwd: process.cwd(),
      env: process.env,
      name: "ace-cloud-codex",
      maxOutputBytes: 2 * 1024 * 1024,
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.on("data", (text: string) => {
      stderr = (stderr + text).slice(-4096);
    });
    const interrupt = () => {
      void child.stop({ graceMs: 100 });
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      void child.stop({ graceMs: 100 });
    }, timeoutMs(args));
    try {
      const exited = await child.exited;
      if (expired || ["output-limit", "signal", "stopped"].includes(exited.reason))
        throw new CliFailure(
          mutates ? "uncertain" : "timeout",
          `Cloud observation ended; accepted work may continue. Idempotency key: ${id}`,
        );
      if (exited.reason === "spawn-error") {
        if (mutates) db.prepare("DELETE FROM receipts WHERE id=?").run(id);
        throw new CliFailure(
          "refused",
          "Install and log in to your own Codex CLI before using cloud commands",
        );
      }
      const receipt = Receipt.parse({
        provider: "codex",
        operation: args.words[2],
        status: exited.code === 0 ? "ok" : "failed",
        exitCode: exited.code ?? 1,
        stdout: stripVTControlCharacters(stdout),
        ...(mutates ? { idempotencyKey: id } : {}),
      });
      if (mutates)
        db.prepare("UPDATE receipts SET result=? WHERE id=?").run(JSON.stringify(receipt), id);
      if (stderr && !args.flags.json && !args.flags.jq)
        process.stderr.write(stripVTControlCharacters(stderr));
      await (mutates ? mutationResult : result)(args, receipt, receipt.status);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      clearTimeout(timer);
      await child.stop({ graceMs: 100 });
    }
  } finally {
    db.close();
  }
}
