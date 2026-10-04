import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  Agent,
  AgentId,
  DeviceId,
  Interaction,
  Item,
  RunId,
  TurnsPageRequest,
  ThreadCatchUpRequest,
  ItemsWindowRequest,
  type Thread,
  type ToolDetail,
  type ToolStatus,
} from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";

export const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
export const root = AgentId.parse("root");
export const device = DeviceId.parse("first-device");

export function storeFixture() {
  const home = mkdtempSync(join(tmpdir(), "ace-long-thread-"));
  const path = join(home, "events.sqlite");
  let clock = 10;
  let store = new Store(
    path,
    (error) => {
      throw error;
    },
    { now: () => clock++ },
  );
  const workspace = store.createWorkspace(home, "Long thread");
  const thread = createDevThread(store, workspace);
  store.appendEvents(
    thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: root,
          threadId: thread.id,
          parentId: null,
          origin: "root",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: home,
          status: { state: "idle" },
          createdAt: 10,
        }),
      },
    ],
    10,
  );
  cleanups.push(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    thread,
    home,
    workspace,
    get store() {
      return store;
    },
    async restart() {
      await store.close();
      store = new Store(
        path,
        (error) => {
          throw error;
        },
        { now: () => clock++ },
      );
    },
  };
}
export function userMessage(id: string, text = id) {
  return Item.parse({
    id,
    agentId: root,
    type: "message",
    role: "user",
    parts: [{ type: "text", text }],
    createdAt: 1,
    complete: true,
  });
}
export function agentMessage(id: string, text = id, runId?: string) {
  return Item.parse({
    id,
    agentId: root,
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text }],
    createdAt: 1,
    complete: true,
    ...(runId ? { runId } : {}),
  });
}
export function tool(id: string, status: ToolStatus, detail: ToolDetail, runId?: string) {
  return Item.parse({
    id,
    agentId: root,
    type: "tool_call",
    complete: status === "succeeded" || status === "failed",
    createdAt: 1,
    ...(runId ? { runId } : {}),
    call: {
      id,
      agentId: root,
      kind: detail.kind,
      title: id,
      status,
      startedAt: 1,
      detail,
      raw: [],
    },
  });
}
export function start(
  store: Store,
  thread: Thread,
  id: string,
  at: number,
  trigger: "user" | "background_completion" = "user",
) {
  return store.appendEvents(
    thread.id,
    [
      { type: "agent.status", agentId: root, status: { state: "working", activity: "thinking" } },
      {
        type: "run.started",
        run: {
          id: RunId.parse(id),
          threadId: thread.id,
          agentId: root,
          trigger,
          state: "active",
          startedAt: at,
        },
      },
    ],
    at,
  );
}
export function end(store: Store, thread: Thread, id: string, at: number) {
  store.appendEvents(
    thread.id,
    [
      { type: "run.ended", runId: RunId.parse(id), state: "completed", endedAt: at },
      { type: "agent.status", agentId: root, status: { state: "idle" } },
    ],
    at,
  );
}
export function turns(
  store: Store,
  thread: Thread,
  cursors: { before?: number; after?: number; limit?: number } = {},
) {
  return store.turnsPage(
    TurnsPageRequest.parse({
      type: "turns.page",
      requestId: "turns",
      threadId: thread.id,
      ...cursors,
    }),
  );
}
export function catchUp(
  store: Store,
  thread: Thread,
  since: { sinceSeq: number } | { sinceTime: number },
) {
  return store.threadCatchUp(
    ThreadCatchUpRequest.parse({
      type: "thread.catchUp",
      requestId: "catch-up",
      threadId: thread.id,
      ...since,
    }),
  );
}
export function window(
  store: Store,
  thread: Thread,
  target: { aroundSeq: number } | { turnOrdinal: number },
  before = 0,
  after = 0,
) {
  return store.itemsWindow(
    ItemsWindowRequest.parse({
      type: "items.window",
      requestId: "window",
      threadId: thread.id,
      ...target,
      before,
      after,
    }),
  );
}
export function approval(thread: Thread, id: string, toolCallId?: string) {
  return Interaction.parse({
    id,
    threadId: thread.id,
    agentId: root,
    ...(toolCallId ? { toolCallId } : {}),
    blocking: true,
    request: {
      kind: "approval",
      title: "Run command",
      options: [{ id: "allow", label: "Allow once", kind: "allow_once" }],
    },
    state: "pending",
    createdAt: 1,
  });
}
