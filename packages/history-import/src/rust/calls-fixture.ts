import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cwd = "/workspace/project";
const session = "44444444-4444-4444-8444-444444444444";
const line = (record: Record<string, unknown>) =>
  JSON.stringify({ sessionId: session, cwd, timestamp: "2026-01-01T00:00:00.000Z", ...record });

/**
 * Tool calls whose pairing with results the readers must agree on: a `tool_use` with no id
 * before one with an id, and a result in the same record as its call.
 */
export async function callsHome(root: string) {
  const home = join(root, "calls");
  await mkdir(join(home, "projects/p"), { recursive: true });
  const lines = [
    line({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      message: { role: "user", content: "Run them" },
    }),
    line({
      type: "assistant",
      uuid: "u2",
      parentUuid: "u1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Bash", input: { command: "echo no id" } },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/a.ts" } },
          { type: "tool_use", id: "t3", name: "Bash", input: { command: "echo inline" } },
          { type: "tool_result", tool_use_id: "t3", content: "inline result" },
        ],
      },
    }),
    line({
      type: "user",
      uuid: "u3",
      parentUuid: "u2",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "read output" }],
      },
    }),
  ];
  await writeFile(join(home, "projects/p", `${session}.jsonl`), lines.join("\n") + "\n");
  return [{ id: "calls", provider: "claude" as const, homeDir: home }];
}

/** Every derived id and the fixture root written out of a value, so homes anywhere compare. */
export function withoutRoot(value: unknown, root: string, ids: Record<string, string>): unknown {
  let text = JSON.stringify(value).replaceAll(root, "<root>");
  for (const [id, label] of Object.entries(ids)) text = text.replaceAll(id, label);
  return JSON.parse(text);
}
