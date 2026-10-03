import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Command, Capabilities, ThreadId } from "@ace/protocol";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import type { Fact } from "@ace/core";
// Non-gating; controlled provider boundary, no installed CLI and no prompts.
const home = mkdtempSync(join(tmpdir(), "ace-queue-bench-"));
const store = new Store(join(home, "events.sqlite"));
const registry = new AdapterRegistry();
const frames: Fact[] = [
  { type: "turn.started", agent: "root", trigger: "user" },
  { type: "turn.ended", agent: "root", outcome: "completed" },
];
const adapter = createScriptedAdapter({
  provider: "codex",
  capabilities: Capabilities.parse({
    steer: false,
    interruptCascades: false,
    resume: true,
    fork: false,
    subagentTranscripts: true,
    backgroundTaskControl: true,
    backgroundVisibility: "full",
    planMode: false,
    tokenUsage: true,
    imageInput: true,
    rewindFiles: false,
  }),
  createTranslator: () => ({ translate: () => frames, tick: () => [] }),
  steps: [{ on: "send", frames: [{ seq: 1, t: 1, dir: "recv", channel: "bench", data: {} }] }],
});
registry.register(adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
const engine = new Engine(store, {
  registry,
  clock: { now: () => 1000, setTimer: () => () => {} },
  threadId: () => "bench",
});
const threadId = ThreadId.parse("bench");
function dispatch(value: unknown) {
  const command = Command.parse(value);
  const result = store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, store),
  );
  if (!result.ok) throw new Error(result.error);
}
try {
  const workspaceId = store.createWorkspace(home, "Bench");
  dispatch({
    id: "create",
    deviceId: "bench",
    payload: {
      type: "thread.create",
      provider: "codex",
      workspaceId,
      input: [{ type: "text", text: "fixture" }],
    },
  });
  await engine.flush();
  dispatch({
    id: "pause",
    deviceId: "bench",
    payload: { type: "queue.pause", threadId, expectedRevision: engine.queue(threadId).revision },
  });
  for (let i = 0; i < 128; i++)
    dispatch({
      id: `queued-${i}`,
      deviceId: "bench",
      payload: { type: "thread.send", threadId, input: [{ type: "text", text: `message ${i}` }] },
    });
  const iterations = 10000;
  let revision = engine.queue(threadId).revision;
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    dispatch({
      id: `edit-${i}`,
      deviceId: "bench",
      payload: {
        type: "queue.edit",
        threadId,
        expectedRevision: revision++,
        messageId: `queued-${i % 128}`,
        input: [{ type: "text", text: `replacement ${i}` }],
      },
    });
  }
  const elapsed = performance.now() - started;
  console.log(
    `SQLite queue CAS/receipt: ${Math.round((iterations * 1000) / elapsed)} ops/s, ${((elapsed * 1000) / iterations).toFixed(2)} us/op`,
  );
  console.log(`Peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`);
} finally {
  await engine.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
}
