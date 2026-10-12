import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  FakeDaemon,
  ScenarioPlayer,
  flakyCheckout,
  workCardScenario,
  facts,
} from "@ace/fake-daemon";

const daemon = new FakeDaemon({
  clock: Date.now,
  hostId: "android-spike-host",
  displayName: "arpan-mbp",
  token: "android-spike-token",
  snapshotItems: 200,
  threadCompletionSchedule: (callback) => setTimeout(callback, 500),
});
const approval = new ScenarioPlayer(daemon, flakyCheckout("approval-thread"));
approval.runUntilBlocked();
approval.autoplay({
  set(ms, callback) {
    const t = setTimeout(callback, ms);
    return () => clearTimeout(t);
  },
});
new ScenarioPlayer(daemon, workCardScenario("many-agents")).runUntilBlocked();
daemon.createThread({
  id: "stream-thread",
  workspaceId: "ace-next",
  title: "ace CLI phase 2",
  provider: "codex",
});
daemon.apply("stream-thread", [facts.rootAgent("codex"), facts.turn("root")]);
for (let i = 0; i < 1000; i++) {
  daemon.apply("stream-thread", [
    facts.message(
      "root",
      `prompt-${i}`,
      "user",
      i === 999
        ? "Add ace kill-all. It should stop every agent process safely."
        : `Check restart recovery ${i + 1}.`,
    ),
    facts.message(
      "root",
      `reply-${i}`,
      "assistant",
      i === 999
        ? "I mapped the process tree. Stopping the supervisor now waits for every child and checks the process identity before sending a signal."
        : `Recovery check ${i + 1} preserves pending sends and the daemon's canonical status.`,
    ),
  ]);
}
daemon.apply("stream-thread", [
  facts.message(
    "root",
    "live",
    "assistant",
    "The streaming review is checking process ownership",
    false,
  ),
]);
let ticks = 0;
const stream = setInterval(() => {
  daemon.apply("stream-thread", [
    facts.stream(
      "root",
      "live",
      ticks % 25 === 0 ? "\nEach child keeps its owner across restarts." : " .",
    ),
  ]);
  ticks++;
}, 100);
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/metrics") response.end(JSON.stringify({ streamTicks: ticks }));
  else {
    response.statusCode = 404;
    response.end("{}");
  }
});
const sockets = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });
sockets.on("connection", (socket) => {
  const connection = daemon.connect({
    send: (text) => socket.send(text),
    close: (code) => socket.close(code),
  });
  socket.on("message", (data) => connection.receive(data.toString()));
  socket.on("close", () => connection.close());
});
server.listen(4345, "127.0.0.1", () =>
  console.log("Android fake daemon on 127.0.0.1:4345; 2,001 transcript items, 10 deltas/s."),
);
function stop() {
  clearInterval(stream);
  sockets.close();
  server.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
