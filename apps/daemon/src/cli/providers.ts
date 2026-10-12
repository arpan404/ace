import { z } from "zod";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { print, result } from "./io.ts";
import { CliFailure } from "./output.ts";
import { setTimeout as delay } from "node:timers/promises";
export async function providersCommand(args: Args, client: Client, signal: AbortSignal) {
  validateArgs(args, [], args.words[0] === "providers" ? 2 : 1);
  if (args.words[0] === "providers" && args.words[1] !== "status")
    throw new CliFailure("refused", "Usage: ace providers status");
  const providers = await client.request(
    { type: "providers.request", operation: "list" },
    { signal },
  );
  if (!providers.result.ok) throw new CliFailure("refused", providers.result.error);
  if (args.words[0] === "providers") return result(args, providers.result);
  const models = await client.request(
    { type: "models.list", options: { offset: 0, limit: 100 } },
    { signal },
  );
  const permissions = [];
  for (const provider of providers.result.providers)
    permissions.push({
      provider: provider.provider,
      result: await client.request(
        { type: "permissions.capabilities", provider: provider.provider },
        { signal },
      ),
    });
  const tools = await client.request(
    { type: "cli.request", operation: { op: "capabilities" } },
    { signal },
  );
  return result(args, {
    providers: providers.result.providers,
    models: models.result,
    permissions,
    tools: tools.result,
  });
}
export async function loginCommand(args: Args, client: Client, signal: AbortSignal) {
  validateArgs(args, ["instance", "stream"], 2);
  const provider = z.enum(["codex", "claude"]).parse(args.words[1]);
  let response = await client.request(
    { type: "provider.login.start", provider, instance: option(args, "instance"), method: "login" },
    { signal },
  );
  let previous = -1;
  let session: string | undefined;
  try {
    while (response.result.ok) {
      const progress = response.result.progress;
      session = progress.session;
      if (progress.sequence !== previous) {
        previous = progress.sequence;
        if (args.flags.stream === "jsonl") await print(args, { type: "login", progress });
        else if (progress.url || progress.userCode)
          process.stderr.write(`${progress.url ?? ""}\n${progress.userCode ?? ""}\n`);
      }
      if (progress.state === "succeeded") return result(args, { provider, status: "ok" });
      if (["failed", "cancelled", "awaiting_input", "awaiting_api_key"].includes(progress.state))
        return result(
          args,
          progress,
          progress.manual || progress.state === "awaiting_input" ? "needs-human" : "failed",
        );
      await delay(250, undefined, { signal });
      response = await client.request(
        { type: "provider.login.poll", session: progress.session },
        { signal },
      );
    }
    throw new CliFailure("refused", response.result.error);
  } finally {
    if (session && signal.aborted && client.state === "ready")
      await client.request({ type: "provider.login.cancel", session }).catch(() => {});
  }
}
