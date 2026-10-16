import { ThreadId, ToolEnvKey, ToolEnvRequest, ToolEnvResult } from "@ace/protocol";
import type { Client } from "@ace/client";
import { validateArgs, type Args } from "./args.ts";
import { result } from "./io.ts";
import { CliFailure } from "./output.ts";

/**
 * Read named credentials from the CLI process environment. Values never
 * appear in argv, shell history or diagnostics; only allowlisted names are
 * accepted and the local copies are blanked after sending.
 */
export function readToolEnvEntries(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
): Array<{ key: string; value: string }> {
  if (names.length === 0 || names.length > 4)
    throw new CliFailure("refused", "Name one to four credentials");
  return names.map((name) => {
    if (!ToolEnvKey.safeParse(name).success)
      throw new CliFailure("refused", `Unsupported credential name: ${name}`);
    const value = env[name];
    if (!value) throw new CliFailure("refused", `${name} is not set in the CLI environment`);
    return { key: name, value };
  });
}

export async function toolEnvCommand(
  args: Args,
  client: Client,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  const verb = args.words[1];
  validateArgs(args, [], verb === "submit" ? 3 : 3, verb === "submit" ? 7 : 3);
  if (verb !== "submit" && verb !== "clear") throw new CliFailure("refused", "See ace --help.");
  const threadId = ThreadId.parse(args.words[2]);
  const entries = verb === "submit" ? readToolEnvEntries(args.words.slice(3), env) : [];
  let request: ToolEnvRequest;
  try {
    request =
      verb === "submit"
        ? ToolEnvRequest.parse({
            type: "provider.toolEnv.submit",
            requestId: crypto.randomUUID(),
            threadId,
            entries,
          })
        : ToolEnvRequest.parse({
            type: "provider.toolEnv.clear",
            requestId: crypto.randomUUID(),
            threadId,
          });
  } catch {
    throw new CliFailure("refused", "Invalid tool credential submission");
  } finally {
    for (const entry of entries) entry.value = "";
  }
  const response = await client.request(request, { signal }).catch((error: unknown) => {
    throw new CliFailure(
      "uncertain",
      `Tool credential acknowledgement unavailable: ${error instanceof Error ? error.message : "failed"}`,
    );
  });
  const parsed = ToolEnvResult.safeParse(response);
  if (!parsed.success) throw new CliFailure("refused", "Unexpected tool credential response");
  if (!parsed.data.result.ok) throw new CliFailure("refused", parsed.data.result.error);
  return result(args, { threadId, stored: parsed.data.result.stored });
}
