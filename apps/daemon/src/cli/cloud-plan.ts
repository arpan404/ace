import { z } from "zod";
import { option, validateArgs, type Args } from "./args.ts";
const task = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/);
/** Pure argv construction; prompts and paths never enter a shell. */
export function cloudPlan(args: Args, text?: string): string[] {
  const verb = z.enum(["exec", "list", "status", "diff", "apply"]).parse(args.words[2]);
  if (args.words[1] !== "codex") throw new Error("Only the installed Codex Cloud CLI is supported");
  validateArgs(
    args,
    ["env", "attempts", "branch", "limit", "cursor", "attempt", "idempotency-key"],
    verb === "list" ? 3 : verb === "exec" ? 3 : 4,
    verb === "exec" ? 4 : verb === "list" ? 3 : 4,
  );
  const native = ["cloud", verb];
  const environment = option(args, "env");
  if (environment && (verb === "exec" || verb === "list"))
    native.push("--env", task.parse(environment));
  if (verb === "exec") {
    if (!environment) throw new Error("Codex Cloud execution requires --env ENV_ID");
    const attempts = option(args, "attempts");
    if (attempts)
      native.push("--attempts", String(z.coerce.number().int().min(1).max(4).parse(attempts)));
    const branch = option(args, "branch");
    if (branch) native.push("--branch", z.string().min(1).max(1024).parse(branch));
    native.push("--", z.string().min(1).max(16384).parse(text));
  } else if (verb === "list") {
    native.push("--json");
    const limit = option(args, "limit");
    if (limit) native.push("--limit", String(z.coerce.number().int().min(1).max(20).parse(limit)));
    const cursor = option(args, "cursor");
    if (cursor) native.push("--cursor", z.string().min(1).max(2048).parse(cursor));
  } else {
    const attempt = option(args, "attempt");
    if (attempt)
      native.push("--attempt", String(z.coerce.number().int().min(1).max(4).parse(attempt)));
    native.push("--", task.parse(args.words[3]));
  }
  return native;
}
