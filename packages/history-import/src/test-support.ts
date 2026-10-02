import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { AgentId, ThreadId, WorkspaceId, type Item, type Agent, type Thread } from "@ace/protocol";
import { openHistory, type ImportSink, type HistoryOptions, type HistoryService } from "./index.ts";

export const nativeId = "11111111-1111-4111-8111-111111111111";
export const otherId = "22222222-2222-4222-8222-222222222222";
export const cwd = "/workspace/project";
export async function jsonl(path: string, records: unknown[], tail = "") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((r) => JSON.stringify(r) + "\n").join("") + tail);
}
export function claudeRecords(prompt = "hello", id = nativeId): unknown[] {
  return [
    {
      type: "user",
      sessionId: id,
      cwd,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: prompt },
    },
    {
      type: "assistant",
      sessionId: id,
      cwd,
      message: {
        role: "assistant",
        model: "claude-model",
        content: [{ type: "text", text: "answer" }],
      },
    },
  ];
}
export function codexRecords(): unknown[] {
  return [
    { type: "session_meta", payload: { id: nativeId, cwd } },
    { type: "turn_context", payload: { model: "codex-model", cwd } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "codex prompt" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "tool1",
        arguments: '{"cmd":"pwd"}',
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "tool1", output: "/workspace/project" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "codex answer" }],
      },
    },
  ];
}
export function init(sourceId: string, id = "imported-thread") {
  return {
    sourceId,
    threadId: ThreadId.parse(id),
    workspaceId: WorkspaceId.parse("workspace"),
    agentId: AgentId.parse("root-" + id),
    at: 123456,
  };
}
export async function environment(instances: HistoryOptions["instances"] = []): Promise<{
  root: string;
  start: (homes?: HistoryOptions["instances"]) => Promise<HistoryService>;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ace-history-"));
  const services: HistoryService[] = [];
  return {
    root,
    start: async (homes = instances) => {
      const service = await openHistory({
        indexPath: join(root, "ace/index.sqlite"),
        instances: homes,
      });
      services.push(service);
      return service;
    },
    close: async () => {
      for (const service of services) await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export function memorySink(): ImportSink & {
  items: Item[];
  agents: Agent[];
  thread: Thread | undefined;
  committed: boolean;
  rolledBack: boolean;
} {
  const sink = {
    items: [] as Item[],
    agents: [] as Agent[],
    thread: undefined as Thread | undefined,
    committed: false,
    rolledBack: false,
    async begin(thread: Thread) {
      sink.thread = thread;
    },
    async appendAgent(agent: Agent) {
      sink.agents.push(agent);
    },
    async appendItem(item: Item) {
      sink.items.push(item);
    },
    async beginBlob() {},
    async appendBlob() {},
    async endBlob() {},
    async commit() {
      sink.committed = true;
    },
    async rollback() {
      sink.rolledBack = true;
    },
  };
  return sink;
}
export function text(items: Item[]): string {
  return items
    .flatMap((i) =>
      i.type === "message" ? i.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [],
    )
    .join(" ");
}
