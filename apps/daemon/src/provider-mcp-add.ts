import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServerInput } from "@ace/protocol";

const run = promisify(execFile);
/** Claude's CLI owns persistence. Output may contain config secrets, so it never leaves this boundary. */
export async function addClaudeMcp(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  name: string,
  input: unknown,
): Promise<void> {
  const server = McpServerInput.parse(input);
  const args = [
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    server.transport === "http" ? "http" : "stdio",
    name,
    ...(server.transport === "http" ? [server.url] : ["--", server.command, ...server.args]),
  ];
  try {
    await run(executable, args, { cwd, env, timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error(
      "Could not save the MCP server. Check its command or URL in Claude Code and try again.",
    );
  }
}
