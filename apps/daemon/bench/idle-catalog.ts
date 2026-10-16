import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { z } from "zod";
import { AutomationStore } from "@ace/automations";
import { ClientMessage, ServerMessage } from "@ace/protocol";
import { startDaemon } from "../src/index.ts";

// Run with env -i and HOME/ACE_HOME/provider homes in a temporary directory;
// see README.md. No inherited user configuration belongs in this experiment.
// No provider processes or model requests are needed for this workload.
const home = process.env.ACE_HOME;
if (!home?.startsWith("/tmp/ace-idle-") || !process.env.HOME?.startsWith("/tmp/ace-idle-"))
  throw new Error("Use an isolated /tmp/ace-idle-* HOME and ACE_HOME");
if (process.env.PATH !== "" || !process.env.CODEX_HOME?.startsWith(`${process.env.HOME}/`))
  throw new Error("Use the isolated environment from bench/README.md");
await mkdir(home, { recursive: true });
const contexts = z.coerce
  .number()
  .int()
  .min(1)
  .max(8)
  .parse(process.env.IDLE_CONTEXTS ?? 8);
const jobs = z.coerce
  .number()
  .int()
  .min(0)
  .max(1000)
  .parse(process.env.IDLE_AUTOMATIONS ?? 256);
const seconds = z.coerce
  .number()
  .int()
  .min(1)
  .max(600)
  .parse(process.env.IDLE_SECONDS ?? 60);
const daemon = await startDaemon({ commands: { instances: [] }, modelInstances: [] });
while (!daemon.commands) await sleep(20);
const workspaceHome = await realpath(home);
const workspaces: string[] = [];
for (let i = 0; i < contexts; i++) {
  const workspace = join(workspaceHome, `workspace-${i}`);
  await mkdir(join(workspace, ".ace/prompts"), { recursive: true });
  await writeFile(join(workspace, ".ace/prompts/review.md"), "Review the changes");
  workspaces.push(workspace);
}
const automations = new AutomationStore(join(home, "automations.sqlite"));
for (let i = 0; i < jobs; i++)
  automations.put(
    {
      id: `automation-${i}`,
      title: `Review ${i}`,
      enabled: true,
      workspace: workspaces[i % contexts] ?? home,
      provider: "codex",
      prompt: "Review these requirements. ".repeat(5242),
      worktree: false,
      trigger: { kind: "manual" },
      missedRun: "skip",
      concurrency: 1,
      jitterMs: 0,
    },
    undefined,
    undefined,
  );
automations.close();
const socket = new WebSocket(daemon.url);
let publishes = 0;
let errors = 0;
let replies = 0;
const visibleWorkflows = new Set<string>();
socket.on("message", (data) => {
  const message = ServerMessage.parse(JSON.parse(data.toString()));
  if (message.type === "catalog.changed") publishes++;
  if (message.type === "error") errors++;
  if (message.type === "catalog.list.result") replies++;
  if (
    (message.type === "catalog.list.result" || message.type === "catalog.changed") &&
    message.entries.some((entry) => entry.kind === "workflow")
  )
    visibleWorkflows.add(message.requestId);
});
const send = (message: ClientMessage) => socket.send(JSON.stringify(ClientMessage.parse(message)));
await once(socket, "open");
send(
  ClientMessage.parse({
    type: "hello",
    protocolVersion: 1,
    deviceId: "idle-bench",
    token: (await readFile(daemon.tokenPath, "utf8")).trim(),
  }),
);
await once(socket, "message");
const heartbeat = setInterval(() => send({ type: "ping" }), 10_000);
// Wait for the real command service, then subscribe all contexts on a real socket.
while (!daemon.commands) await sleep(20);
for (const [i, workspace] of workspaces.entries()) {
  const id = daemon.store.createWorkspace(workspace, `Idle ${i}`);
  send({
    type: "catalog.list",
    requestId: `catalog-${i}`,
    workspace: { workspaceId: id, provider: "codex" },
    subscribe: true,
    query: "",
    limit: 128,
  });
}
await sleep(10_000);
if (replies !== contexts || errors)
  throw new Error(`Catalog setup failed: ${replies} replies, ${errors} errors`);
for (let i = 0; i < Math.min(contexts, jobs); i++)
  if (!visibleWorkflows.has(`catalog-${i}`))
    throw new Error(`Workspace ${i} has no seeded workflows`);
publishes = 0;
errors = 0;
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const cpu = process.cpuUsage();
const start = performance.now();
process.stdout.write(
  `${JSON.stringify({ phase: "measuring", pid: process.pid, contexts, jobs, seconds, home })}\n`,
);
await sleep(seconds * 1000);
const elapsed = performance.now() - start;
const used = process.cpuUsage(cpu);
delay.disable();
process.stdout.write(
  `${JSON.stringify({
    phase: "result",
    contexts,
    jobs,
    elapsedMs: elapsed,
    cpuPercent: (used.user + used.system) / (elapsed * 10),
    publishes,
    errors,
    visibleWorkflowCatalogs: visibleWorkflows.size,
    maxLoopDelayMs: delay.max / 1e6,
    p99LoopDelayMs: delay.percentile(99) / 1e6,
    daemonLoop: daemon.eventLoop(),
  })}\n`,
);
clearInterval(heartbeat);
if (socket.readyState !== WebSocket.CLOSED) {
  socket.close();
  await once(socket, "close");
}
await daemon.close();
