import { FakeDaemon, facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";

const daemon = new FakeDaemon({
  clock: Date.now,
  hostId: "ios-spike-host",
  displayName: "arpan-mbp",
  token: "ios-spike-token",
  snapshotItems: 200,
});
const details = (branch: string) => ({
  workspace: { id: "ace", name: "ace-next", path: "/tmp/ace-ios-spike" },
  branch,
  machine: { host: "ios-spike-host", name: "arpan-mbp" },
});
daemon.createThread({
  id: "ios-stream",
  workspaceId: "ace",
  title: "ace CLI phase 2",
  provider: "codex",
  details: details("feat/ace-cli-control"),
  live: { model: "gpt-6.1 · high", subagentCount: 0, backgroundTaskCount: 0 },
});
daemon.apply("ios-stream", [facts.rootAgent("codex"), facts.turn("root")]);
for (let start = 0; start < 1999; start += 100) {
  const batch: Fact[] = [];
  for (let i = start; i < Math.min(start + 100, 1999); i++)
    batch.push(
      facts.message(
        "root",
        `history-${i}`,
        i % 5 === 0 ? "user" : "assistant",
        `History ${i + 1}. ${i % 5 === 0 ? "Keep process ownership explicit." : "The daemon records each child process and its kernel start time. Reconnect and replay keep the same canonical facts on every device."}`,
      ),
    );
  daemon.apply("ios-stream", batch);
}
daemon.apply("ios-stream", [
  facts.message(
    "root",
    "stream",
    "assistant",
    "Orphan cleanup now records each child's kernel start time and owner, so a reused PID is never killed.",
    false,
  ),
]);
daemon.createThread({
  id: "ios-approval",
  workspaceId: "ace",
  title: "Fix the flaky queue test",
  provider: "codex",
  details: details("fix/queue"),
  permissionMode: "ask",
});
daemon.apply("ios-approval", [
  facts.rootAgent("codex"),
  facts.turn("root"),
  facts.message("root", "ask", "user", "Fix the flaky queue test, then push the branch."),
  facts.tool("root", "edit", {
    kind: "file.read",
    title: "Read queue.test.ts",
    detail: { kind: "file.read", path: "queue.test.ts" },
  }),
  facts.toolDone("root", "edit"),
  facts.message(
    "root",
    "answer",
    "assistant",
    "The retry timer used wall-clock time, so a slow CI box could fire it twice. The test now pins the injected clock. All 214 tests pass.",
  ),
  facts.tool("root", "push", {
    kind: "shell",
    title: "Codex wants to run a command",
    status: "awaiting_approval",
    detail: { kind: "shell", command: "git push origin fix/queue" },
  }),
  {
    type: "interaction.opened",
    agent: "root",
    interaction: "push",
    item: "push",
    blocking: true,
    request: {
      kind: "approval",
      title: "Codex wants to run a command",
      description: "Publishes 2 commits to GitHub",
      options: [
        { id: "deny", label: "Deny", kind: "deny" },
        { id: "always", label: "Always here", kind: "allow_session" },
        { id: "allow", label: "Allow", kind: "allow_once" },
      ],
    },
  },
]);
daemon.createThread({
  id: "ios-done",
  workspaceId: "ace",
  title: "Tighten the composer spacing",
  provider: "codex",
  details: details("main"),
});
daemon.apply("ios-done", [
  facts.rootAgent("codex"),
  facts.turn("root"),
  facts.message(
    "root",
    "done",
    "assistant",
    "The composer respects Dynamic Type and the keyboard safe area.",
  ),
  facts.endTurn("root"),
]);
daemon.createThread({
  id: "ios-tree",
  workspaceId: "ace",
  title: "Review PID-reuse safety",
  provider: "codex",
  details: details("feat/process-owner"),
});
daemon.apply("ios-tree", [
  facts.rootAgent("codex"),
  facts.turn("root"),
  facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
  facts.turn("reviewer", "spawn"),
  facts.endTurn("root"),
]);

const connections = new Map<ServerWebSocket<undefined>, ReturnType<FakeDaemon["connect"]>>();
let online = true;
let deltas = 0;
let commands = 0;
let snapshots = 0;
let replays = 0;
const Control = z.object({ online: z.boolean() });
const server = Bun.serve<undefined>({
  hostname: "127.0.0.1",
  port: 9841,
  async fetch(request, listener) {
    const path = new URL(request.url).pathname;
    if (path === "/health")
      return Response.json({ head: daemon.head, deltas, commands, snapshots, replays });
    if (path === "/control" && request.method === "POST") {
      online = Control.parse(await request.json()).online;
      if (!online) for (const socket of connections.keys()) socket.close(1001);
      return Response.json({ online });
    }
    if (path === "/state")
      return Response.json(
        daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("ios-stream") }),
      );
    if (online && listener.upgrade(request)) return;
    return new Response("Unavailable", { status: 503 });
  },
  websocket: {
    open(socket) {
      connections.set(
        socket,
        daemon.connect({
          send: (text) => {
            if (text.includes('"type":"snapshot"')) snapshots++;
            if (text.includes('"type":"events"')) replays++;
            socket.send(text);
          },
          close: (code) => socket.close(code),
        }),
      );
    },
    message(socket, data) {
      if (typeof data === "string") {
        if (data.includes('"type":"command"')) commands++;
        connections.get(socket)?.receive(data);
      }
    },
    close(socket) {
      connections.get(socket)?.close();
      connections.delete(socket);
    },
  },
});
const timer = setInterval(() => {
  deltas++;
  daemon.apply("ios-stream", [
    facts.stream("root", "stream", ` Next step ${deltas}: wire the safe kill-all filters.`),
  ]);
}, 50);
process.on("SIGINT", () => {
  clearInterval(timer);
  server.stop(true);
});
console.log(
  "iOS spike daemon on ws://127.0.0.1:9841. No provider processes or subscription quota.",
);
