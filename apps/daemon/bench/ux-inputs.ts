/** Merge-only benchmark. Uses temp homes and an in-process provider, never a real CLI. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { Fact } from "@ace/core";
import { Capabilities, Command, Item } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon, type EngineClock } from "@ace/daemon";

const clock: EngineClock = {
  now: () => Math.floor(performance.now()),
  setTimer(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};
const percentile = (values: number[], fraction: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
for (const history of [0, 1_000, 10_000, 50_000]) {
  const home = await mkdtemp(join(tmpdir(), "ace-ux-bench-"));
  const bundles = new Map<number, Fact[]>();
  const steps = Array.from({ length: 101 }, (_, n) => {
    bundles.set(n, [
      { type: "turn.started", agent: "root", trigger: "user", nativeTurnId: `turn:${n}` },
      {
        type: "item.upsert",
        agent: "root",
        item: `echo:${n}`,
        draft: {
          type: "message",
          role: "user",
          complete: true,
          parts: [{ type: "text", text: `task ${n}` }],
        },
      },
      { type: "turn.ended", agent: "root", outcome: "completed", nativeTurnId: `turn:${n}` },
    ]);
    return {
      on: "send" as const,
      frames: [{ seq: n, t: n, dir: "recv" as const, channel: "scripted", data: {} }],
    };
  });
  const registry = new AdapterRegistry();
  registry.register(
    createScriptedAdapter({
      provider: "codex",
      steps,
      capabilities: Capabilities.parse({
        steer: false,
        interruptCascades: false,
        resume: true,
        fork: false,
        subagentTranscripts: true,
        backgroundTaskControl: true,
        backgroundVisibility: "full",
        planMode: false,
        tokenUsage: false,
        imageInput: false,
        rewindFiles: false,
      }),
      createTranslator: () => ({
        translate: (frame) => bundles.get(frame.seq) ?? [],
        tick: () => [],
      }),
    }),
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    engine: { registry, clock },
    modelInstances: [],
  });
  try {
    const engine = daemon.engine;
    const controls = daemon.agentControl;
    if (!engine || !controls) throw new Error("Benchmark engine unavailable");
    const workspace = daemon.store.createWorkspace(home, "Benchmark");
    const create = Command.parse({
      id: "benchmark-create",
      deviceId: "benchmark",
      payload: {
        type: "thread.create",
        workspaceId: workspace,
        provider: "codex",
        input: [{ type: "text", text: "task 0" }],
      },
    });
    const receipt = daemon.store.recordCommand(create.id, create.deviceId, () =>
      engine.handler.handle(create, daemon.store),
    );
    if (!receipt.threadId) throw new Error("No benchmark thread");
    const id = receipt.threadId;
    await engine.flush();
    const agent = daemon.store.getThread(id)?.rootAgentId;
    if (!agent) throw new Error("No benchmark agent");
    for (let first = 0; first < history; first += 256) {
      daemon.store.appendEvents(
        id,
        Array.from({ length: Math.min(256, history - first) }, (_, offset) => ({
          type: "item.created" as const,
          item: Item.parse({
            id: `history:${first + offset}`,
            agentId: agent,
            createdAt: clock.now(),
            type: "message",
            role: "user",
            parts: [{ type: "text", text: "Later historical input" }],
            complete: true,
          }),
        })),
        clock.now(),
      );
    }
    const rssBefore = process.memoryUsage().rss;
    const titleMs: number[] = [],
      echoMs: number[] = [];
    for (let n = 1; n <= 100; n++) {
      const begin = performance.now();
      const titled = await controls.port.execute(
        { sessionId: "benchmark", threadId: id, agentId: agent },
        { op: "thread.regenerate_title", threadId: id },
        new AbortController().signal,
      );
      if (!titled.ok || daemon.store.getThread(id)?.title !== "task 0")
        throw new Error("Incorrect oldest title");
      titleMs.push(performance.now() - begin);
      const started = performance.now();
      const command = Command.parse({
        id: `send:${n}`,
        deviceId: "benchmark",
        payload: {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: `task ${n}` }],
        },
      });
      const sent = daemon.store.recordCommand(command.id, command.deviceId, () =>
        engine.handler.handle(command, daemon.store),
      );
      if (!sent.ok) throw new Error("Send admission refused");
      await engine.flush();
      echoMs.push(performance.now() - started);
    }
    console.log(
      JSON.stringify({
        history,
        samples: 100,
        titleP50Ms: percentile(titleMs, 0.5),
        titleP95Ms: percentile(titleMs, 0.95),
        admissionEchoP50Ms: percentile(echoMs, 0.5),
        admissionEchoP95Ms: percentile(echoMs, 0.95),
        rssDeltaMiB: (process.memoryUsage().rss - rssBefore) / 1024 / 1024,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  } finally {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
}
