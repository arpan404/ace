import { type ToolDetail } from "@ace/protocol";
import { object, string as nativeString } from "@ace/native-session";

/** Native file history contains tool inputs; live transport command IDs are unrelated. */
export function historyToolDetail(block: Record<string, unknown>): ToolDetail {
  const name = string(block.name) ?? string(block.tool);
  let input = object(block.input ?? object(block.state).input);
  if (typeof block.arguments === "string") {
    try {
      input = object(JSON.parse(block.arguments));
    } catch {
      /* unparsed arguments remain raw */
    }
  }
  if (name === "Bash" || name === "bash" || name === "exec_command") {
    const command = string(input.command) ?? string(input.cmd);
    if (command) return { kind: "shell", command };
  }
  if (name === "Read" || name === "read") {
    const path = string(input.file_path) ?? string(input.filePath);
    if (path) return { kind: "file.read", path };
  }
  if (name === "Edit" || name === "edit" || name === "Write" || name === "write") {
    const path = string(input.file_path) ?? string(input.filePath);
    if (path)
      return {
        kind: name === "Write" || name === "write" ? "file.write" : "file.edit",
        changes: [
          {
            kind: "update",
            path,
            ...(string(input.old_string) ? { oldText: string(input.old_string) } : {}),
            ...(string(input.new_string) ? { newText: string(input.new_string) } : {}),
          },
        ],
      };
  }
  if (name === "Task" || name === "task" || name === "spawn_agent")
    return {
      kind: "agent.spawn",
      ...(string(input.prompt) ? { prompt: string(input.prompt) } : {}),
      ...(string(input.description) ? { description: string(input.description) } : {}),
    };
  return { kind: "custom" };
}

function string(value: unknown): string | undefined {
  return nativeString(value)?.slice(0, 4096);
}
