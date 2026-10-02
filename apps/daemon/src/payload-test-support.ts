import { Item } from "@ace/protocol";
export function shell(id = "shell") {
  return Item.parse({
    id,
    agentId: "root",
    type: "tool_call",
    complete: false,
    createdAt: 1,
    call: {
      id,
      agentId: "root",
      kind: "shell",
      title: "Shell",
      status: "running",
      startedAt: 1,
      raw: [],
      detail: { kind: "shell", command: "echo" },
    },
  });
}
export function message(id: string, text = id) {
  return Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "assistant",
    complete: true,
    createdAt: 1,
    parts: [{ type: "text", text }],
  });
}
