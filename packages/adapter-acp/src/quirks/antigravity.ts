import type { ToolKind } from "@ace/protocol";
import { object, string } from "../data.ts";
import { baseCapabilities, type AcpQuirks } from "./types.ts";
const names: Record<string, ToolKind> = {
  start_subagent: "agent.spawn",
  run_command: "shell",
  shell: "shell",
  view_file: "file.read",
  read_file: "file.read",
  client_view_file: "file.read",
  create_file: "file.write",
  write_to_file: "file.write",
  write_file: "file.write",
  client_create_file: "file.write",
  edit_file: "file.edit",
  replace_file_content: "file.edit",
  multi_replace_file_content: "file.edit",
  client_edit_file: "file.edit",
  grep_search: "search",
  search_directory: "search",
  find_by_name: "search",
  find_file: "search",
  list_dir: "search",
  list_directory: "search",
  search_web: "web.search",
  read_url_content: "web.fetch",
  call_mcp_tool: "mcp",
  generate_image: "image",
  ask_question: "ask_user",
};
export const antigravityQuirks: AcpQuirks = {
  provider: "antigravity",
  command: "agy_acp_server",
  args: [],
  experimental: true,
  clientMeta: {},
  toolKind(update) {
    const name = string(update["name"]) || string(update["title"]);
    if (name.startsWith("chrome_devtools/")) return "browser";
    if (object(update["_meta"])["is_mcp_tool_call"]) return "mcp";
    return Object.hasOwn(names, name) ? names[name] : undefined;
  },
  classifyError(text) {
    if (text.startsWith("Usage Limit Reached")) return { kind: "quota", message: text };
    if (text.startsWith("Agent execution error:")) return { kind: "provider", message: text };
    if (text.toLowerCase().startsWith("connection lost")) return { kind: "network", message: text };
    return undefined;
  },
  capabilities(version) {
    const supported = /^1\.(?:[2-9]|\d{2,})\./.test(version ?? "");
    return { ...baseCapabilities, resume: supported, imageInput: supported };
  },
};
