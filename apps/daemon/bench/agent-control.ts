// Non-gating benchmark. Do not run locally under the current repo-owner rule.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { summarizeThreadReference } from "@ace/context";
import { Store, Engine, AdapterRegistry, DelegationService } from "@ace/daemon";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import {
  Item,
  ThreadRefContextItem,
  Capabilities,
  type ThreadId,
  type McpAttribution,
} from "@ace/protocol";
import type { EngineClock } from "@ace/daemon";
import type { Fact } from "@ace/core";

const home = mkdtempSync(join(tmpdir(), "ace-agent-bench-"));
const store = new Store(join(home, "events.sqlite"));
const workspace = store.createWorkspace(home, "bench");
const registry = new AdapterRegistry();
const clock: EngineClock = { now: () => 1000, setTimer: () => () => {} };
const capabilities = Capabilities.parse({
  steer: false,
  interruptCascades: false,
  resume: true,
  fork: false,
  subagentTranscripts: true,
  backgroundTaskControl: false,
  backgroundVisibility: "full",
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
});
registry.register(
  createScriptedAdapter({
    provider: "codex",
    capabilities,
    createTranslator: () => ({
      translate: () =>
        [
          { type: "turn.started", agent: "root", trigger: "user" },
          { type: "turn.ended", agent: "root", outcome: "completed" },
        ] satisfies Fact[],
      tick: () => [],
    }),
    steps: [{ on: "send", frames: [{ seq: 1, t: 0, dir: "recv", channel: "bench", data: {} }] }],
  }),
  { installed: true, auth: "logged_in", loginHint: "unused" },
);
const engine = new Engine(store, { registry, clock });
const service = new DelegationService({
  store,
  engine,
  clock,
  id: randomUUID,
  policy: { maxConcurrent: 32 },
  onError: (error) => {
    throw error;
  },
});
try {
  const parent = service.command(randomUUID(), {
    type: "thread.create",
    workspaceId: workspace,
    provider: "codex",
    input: [{ type: "text", text: "bench" }],
  });
  if (!parent.ok || !parent.threadId) throw new Error("parent failed");
  await engine.flush();
  const agentId = store.getThread(parent.threadId)?.rootAgentId;
  if (!agentId) throw new Error("Missing root");
  const caller: McpAttribution = { sessionId: "bench", threadId: parent.threadId, agentId };
  const begin = performance.now();
  const children: ThreadId[] = [];
  for (let i = 0; i < 32; i++)
    children.push(
      service.prepare(caller, {
        requestId: `bench-${i}`,
        provider: "codex",
        task: "bench",
        role: "worker",
        wait: false,
        estimatedLoad: 0,
      }).childId,
    );
  const admissionMs = performance.now() - begin;
  const updates = 10000;
  const updateStart = performance.now();
  for (let i = 0; i < updates; i++) {
    const child = children[i % children.length];
    if (!child) throw new Error("Missing child");
    const thread = store.getThread(child);
    if (!thread) throw new Error("Missing thread");
    engine.updateChild(caller.threadId, {
      ...thread,
      status: i % 2 ? { state: "working", agents: 1 } : { state: "waiting", on: "network" },
    });
  }
  const updateMs = performance.now() - updateStart;
  for (const child of children) {
    const edge = service.journal.get(child);
    if (edge) service.launch(edge, "bench");
  }
  await engine.flush();
  const usageBegin = performance.now();
  for (let i = 0; i < 10000; i++) {
    const child = children[i % children.length];
    const root = child ? store.getThread(child)?.rootAgentId : undefined;
    if (!child || !root) throw new Error("Missing usage owner");
    store.appendEvents(
      child,
      [
        {
          type: "usage.updated",
          agentId: root,
          inputTokens: i,
          outputTokens: i,
          cachedInputTokens: 0,
          counterMode: "cumulative",
          counterKey: "bench",
        },
      ],
      1000,
    );
  }
  const usageMs = performance.now() - usageBegin;
  const source = store.getThread(caller.threadId);
  if (!source) throw new Error("Missing context source");
  const item = Item.parse({
    type: "message",
    id: "context",
    agentId,
    createdAt: 1000,
    complete: true,
    role: "assistant",
    parts: [{ type: "text", text: "😀成果".repeat(8000) }],
  });
  const reference = ThreadRefContextItem.parse({
    type: "thread_ref",
    threadId: source.id,
    budgetBytes: 8192,
  });
  const contextBegin = performance.now();
  let summaryBytes = 0;
  for (let i = 0; i < 10000; i++)
    summaryBytes += Buffer.byteLength(
      summarizeThreadReference(reference, source, { items: [item], itemsBefore: 1 }).summary,
    );
  const contextMs = performance.now() - contextBegin;
  console.log(
    JSON.stringify({
      admissionUs: (admissionMs * 1000) / 32,
      statusUpdatesPerSecond: (updates * 1000) / updateMs,
      usageEventsPerSecond: (10000 * 1000) / usageMs,
      contextSummariesPerSecond: (10000 * 1000) / contextMs,
      summaryBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
} finally {
  service.close();
  await engine.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
}
