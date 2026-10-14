import { stripVTControlCharacters } from "node:util";
import type { ProviderKind } from "@ace/protocol";
import { z } from "zod";

/** One-shot invocation: arguments, and whether the prompt goes on stdin or as the last argument. */
export interface UtilityInvocation {
  args: string[];
  stdin: boolean;
}

/**
 * Each provider's non-interactive mode with tools, MCP servers, sessions and customizations off,
 * from the installed CLIs' own `--help`. The run happens in an empty temporary directory.
 */
export function utilityInvocation(
  provider: ProviderKind,
  model: string,
  effort: string | undefined,
  prompt: string,
): UtilityInvocation {
  const chosen = model && model !== "default" ? model : undefined;
  if (provider === "claude")
    return {
      stdin: true,
      args: [
        "--print",
        "--safe-mode",
        "--tools",
        "",
        "--disallowedTools",
        "mcp__*",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        ...(chosen ? ["--model", chosen] : []),
        ...(effort ? ["--effort", effort] : []),
      ],
    };
  if (provider === "codex")
    return {
      stdin: true,
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-c",
        'approval_policy="never"',
        "--json",
        "-c",
        "mcp_servers={}",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "features.apply_patch_freeform=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.apps=false",
        "-c",
        'web_search="disabled"',
        ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
        ...(chosen ? ["--model", chosen] : []),
        "-",
      ],
    };
  if (provider === "pi")
    return {
      stdin: false,
      args: [
        "--print",
        "--mode",
        "text",
        "--no-tools",
        "--no-mcp",
        "--no-session",
        "--no-prompt-templates",
        ...(chosen ? ["--model", chosen] : []),
        ...(effort ? ["--thinking", effort] : []),
        prompt,
      ],
    };
  if (provider === "cursor")
    return {
      stdin: false,
      args: [
        "--print",
        "--output-format",
        "text",
        "--mode",
        "ask",
        ...(chosen ? ["--model", chosen] : []),
        prompt,
      ],
    };
  if (provider === "opencode")
    return {
      stdin: false,
      args: ["run", "--standalone", ...(chosen ? ["--model", chosen] : []), prompt],
    };
  throw new Error("utility_provider_unavailable");
}

const claudeResult = z
  .object({
    is_error: z.boolean().optional(),
    result: z.string().max(32768).optional(),
    structured_output: z.unknown().optional(),
  })
  .passthrough();
const codexEvent = z.object({ type: z.string() }).passthrough();
const completedItem = z.object({ type: z.string() }).passthrough();
const agentMessage = z.object({ text: z.string().max(32768) }).passthrough();

/**
 * The model's final reply from a one-shot run's stdout. Unknown events keep their fields and
 * never establish completion; a reported error throws `utility_provider_failed`.
 */
export function utilityReply(provider: ProviderKind, output: string): string {
  if (provider === "claude") {
    const result = claudeResult.parse(JSON.parse(output));
    if (result.is_error) throw new Error("utility_provider_failed");
    if (result.structured_output !== undefined) return JSON.stringify(result.structured_output);
    return result.result ?? "";
  }
  if (provider === "codex") {
    let text = "";
    let complete = false;
    for (const line of output.split("\n").filter(Boolean)) {
      const event = codexEvent.parse(JSON.parse(line));
      if (event.type === "turn.failed" || event.type === "error")
        throw new Error("utility_provider_failed");
      if (event.type === "turn.completed") complete = true;
      if (event.type === "item.completed") {
        const item = completedItem.parse(event.item);
        if (item.type === "agent_message") text = agentMessage.parse(item).text;
      }
    }
    if (!complete) throw new Error("utility_provider_failed");
    return text;
  }
  return stripVTControlCharacters(output).trim();
}
