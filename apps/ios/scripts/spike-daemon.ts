import { FakeDaemon, facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { CommandId, DeviceId, Notification, ThreadId } from "@ace/protocol";
import { oversizedScenario, approvalRetryScenario } from "./review-scenarios.ts";
import { manyActions, snapshotFrames } from "./many-actions.ts";
import { LostReceipt } from "./lost-receipt.ts";
import { threadScenarios } from "./thread-scenarios.ts";
import { waitingScenario } from "./waiting-scenario.ts";
import { RequestScenario, requestScenarios, seedRequest } from "./request-scenarios.ts";
import { queuedTexts } from "./queue-read.ts";
import { seedSheets } from "./sheet-scenario.ts";
import { seedArchive, snoozeNap } from "./archive-scenario.ts";
import { seedProjects } from "./project-scenario.ts";
import { seedNativeMedia } from "./media-scenario.ts";
import { answerScreenshot, browserControl, realVideo, seedBrowser } from "./spike-browser.ts";
import { featureClosed, featureMessage, spikeDevices } from "./spike-devices.ts";
import { seedFiles } from "./files-scenario.ts";
import { seedWorkLogs } from "./worklog-scenario.ts";
import { seedMessages } from "./message-scenario.ts";
import { busyInbox } from "./busy-inbox-scenario.ts";

/** `ACE_IOS_SPIKE_PORT` lets parallel fixtures share one Mac; the app takes `--spike-port`. */
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(process.env.ACE_IOS_SPIKE_PORT ?? 9841);

/**
 * `ACE_IOS_SPIKE_MACHINE=1` makes this fixture a separate machine with its own host id, for the
 * app's `--spike-machines`; otherwise it is the usual `ios-spike-host` on any port.
 */
const separate = process.env.ACE_IOS_SPIKE_MACHINE === "1";
const hostId = separate ? `ios-spike-host-${port}` : "ios-spike-host";
const machineName = separate ? `studio-${port}` : "arpan-mbp";
const daemon = new FakeDaemon({
  clock: Date.now,
  hostId,
  displayName: machineName,
  token: "ios-spike-token",
  snapshotItems: 200,
});
const details = (branch: string) => ({
  workspace: { id: "ace", name: "ace-next", path: "/tmp/ace-ios-spike" },
  branch,
  machine: { host: hostId, name: machineName },
});
daemon.createThread({
  hasSentMessage: true,
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
// `ACE_IOS_SPIKE_STREAMED=650000` starts the streaming thread as if it had already streamed that
// many deltas (about nine hours at 20 a second), in one append, to check that a thread that has
// run for hours opens as fast as a new one.
const streamed = Number(process.env.ACE_IOS_SPIKE_STREAMED ?? 0);
if (Number.isSafeInteger(streamed) && streamed > 0)
  daemon.apply("ios-stream", [
    facts.stream(
      "root",
      "stream",
      Array.from(
        { length: streamed },
        (_, i) => ` Next step ${i + 1}: wire the safe kill-all filters.`,
      ).join(""),
    ),
  ]);
daemon.createThread({
  hasSentMessage: true,
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
  hasSentMessage: true,
  id: "ios-tree",
  workspaceId: "ace",
  title: "Review PID-reuse safety",
  provider: "codex",
  details: details("feat/process-owner"),
});
seedSheets(daemon);
daemon.createThread({
  hasSentMessage: true,
  id: "ios-snoozed",
  workspaceId: "ace",
  title: "Release notes for 0.9",
  provider: "codex",
  details: details("docs/0.9"),
});
daemon.apply("ios-snoozed", [
  facts.rootAgent("codex"),
  facts.turn("root"),
  facts.message("root", "notes", "assistant", "Drafted the 0.9 release notes."),
  facts.endTurn("root"),
]);
// Organization goes through the daemon's own command path, as a client's would.
daemon.command({
  id: CommandId.parse("ios-spike-snooze"),
  deviceId: DeviceId.parse("ios-spike-seed"),
  payload: {
    type: "thread.snooze",
    threadId: ThreadId.parse("ios-snoozed"),
    until: Date.now() + 3 * 60 * 60 * 1000,
  },
});

threadScenarios(daemon, details);
waitingScenario(daemon, details);
seedArchive(daemon, Date.now(), Number(process.env.ACE_IOS_SPIKE_NAP_MS ?? 90_000));
const busy = Number(process.env.ACE_IOS_SPIKE_INBOX ?? 0);
const busyTimer =
  busy > 0
    ? busyInbox(daemon, details, busy, Number(process.env.ACE_IOS_SPIKE_INBOX_MS ?? 200))
    : undefined;
seedProjects(daemon);
seedNativeMedia(daemon);
seedBrowser(daemon, details);
seedFiles(daemon, details);
seedWorkLogs(daemon);
seedMessages(daemon, details);
requestScenarios(daemon, details);
spikeDevices(daemon, details);
let fresh = 0;
let naps = 0;

const connections = new Map<ServerWebSocket<undefined>, ReturnType<FakeDaemon["connect"]>>();
let online = true;
let deltas = streamed > 0 ? streamed : 0;
let commands = 0;
let snapshots = 0;
let replays = 0;
let fragmentParts = 0;
const Control = z.object({ online: z.boolean() });
let notices = 0;
/** A canonical alert for a seeded thread, as the daemon's notify worker would send it. */
function spikeNotification(threadId: ThreadId, id: string): Notification | undefined {
  const view = daemon.snapshot({ kind: "thread", threadId });
  if (view?.kind !== "thread") return undefined;
  const pending = Object.values(view.interactions).find((entry) => entry.state === "pending");
  const request = pending?.request.kind === "approval" ? pending.request : undefined;
  const allow = request?.options.find((option) => option.kind === "allow_once");
  const deny = request?.options.find((option) => option.kind === "deny");
  return Notification.parse({
    id,
    threadId,
    title: view.thread.title,
    status: pending ? "needs_you" : view.thread.status.state === "failed" ? "failed" : "done",
    ...(pending ? { interactionId: pending.id } : {}),
    backgroundCount: 0,
    actions:
      allow && deny
        ? [
            { action: "approve", optionId: allow.id },
            { action: "deny", optionId: deny.id },
          ]
        : [],
  });
}
const lostReceipt = new LostReceipt();
const server = Bun.serve<undefined>({
  hostname: "127.0.0.1",
  port,
  async fetch(request, listener) {
    const path = new URL(request.url).pathname;
    if (path === "/review/receipt") {
      if (request.method === "POST") {
        lostReceipt.arm(
          z.object({ text: z.string().min(1).max(1024) }).parse(await request.json()).text,
        );
      }
      return Response.json(lostReceipt.state());
    }
    if (path === "/review/many" && request.method === "POST") {
      const input = z
        .object({
          id: z
            .string()
            .regex(/^ios-many-[a-z]+$/)
            .max(64),
        })
        .parse(await request.json());
      manyActions(daemon, input.id);
      return Response.json({ ok: true });
    }
    if (path === "/review/approval" && request.method === "POST") {
      approvalRetryScenario(
        daemon,
        z.enum(["create", "refuse", "accept"]).parse(await request.json()),
      );
      return Response.json({ ok: true });
    }
    if (path === "/review/oversized" && request.method === "POST") {
      oversizedScenario(daemon, z.enum(["create", "work", "approval"]).parse(await request.json()));
      return Response.json({ ok: true });
    }
    // A new thread for one contract test, so answering it never changes another test's thread.
    if (path === "/review/fresh" && request.method === "POST") {
      const scenario = RequestScenario.parse(
        z.object({ scenario: z.string() }).parse(await request.json()).scenario,
      );
      const threadId = `ios-fresh-${scenario}-${++fresh}`;
      seedRequest(daemon, scenario, threadId, details);
      return Response.json({ threadId });
    }
    // Restarts ios-nap's snooze from now, so the offline-snooze test never depends on how long
    // the fixture has been running.
    if (path === "/review/nap" && request.method === "POST") {
      const { ms } = z
        .object({ ms: z.number().int().min(1000).max(600_000) })
        .parse(await request.json());
      snoozeNap(daemon, Date.now() + ms, `ios-spike-nap-${++naps}`);
      return Response.json({ ok: true });
    }
    if (path === "/review/notify" && request.method === "POST") {
      const input = z
        .object({ threadId: ThreadId, id: z.string().min(1).max(64).optional() })
        .parse(await request.json());
      const notification = spikeNotification(input.threadId, input.id ?? `spike:${++notices}`);
      if (!notification) return new Response("Unknown thread", { status: 404 });
      daemon.notify(notification);
      return Response.json(notification);
    }
    if (path === "/review/retract" && request.method === "POST") {
      daemon.retractNotification(
        z.object({ id: z.string().min(1).max(64) }).parse(await request.json()).id,
      );
      return Response.json({ ok: true });
    }
    const browserReply = await browserControl(daemon, request);
    if (browserReply) return browserReply;
    if (path === "/health")
      return Response.json({
        head: daemon.head,
        deltas,
        commands,
        snapshots,
        replays,
        fragmentParts,
      });
    if (path === "/control" && request.method === "POST") {
      online = Control.parse(await request.json()).online;
      if (!online) for (const socket of connections.keys()) socket.close(1001);
      return Response.json({ online });
    }
    if (path === "/queue")
      return Response.json({
        texts: await queuedTexts(
          daemon,
          new URL(request.url).searchParams.get("thread") ?? "ios-stream",
        ),
      });
    if (path === "/state")
      return Response.json(
        daemon.snapshot({
          kind: "thread",
          threadId: ThreadId.parse(new URL(request.url).searchParams.get("thread") ?? "ios-stream"),
        }),
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
            if (lostReceipt.drop(text)) {
              online = false;
              for (const peer of connections.keys()) peer.close(1001);
              return;
            }
            if (text.includes('"type":"snapshot"')) snapshots++;
            if (text.includes('"type":"events"')) replays++;
            for (const frame of snapshotFrames(text)) {
              if (frame.includes('"type":"snapshot.part"')) fragmentParts++;
              socket.send(frame);
            }
          },
          close: (code) => socket.close(code),
          binary: realVideo(daemon, (bytes) => socket.send(bytes)),
        }),
      );
    },
    message(socket, data) {
      if (typeof data === "string") {
        if (featureMessage(daemon, socket, data, connections)) return;
        if (data.includes('"type":"command"')) commands++;
        lostReceipt.observe(data);
        if (answerScreenshot(data, (text) => socket.send(text), daemon)) return;
        connections.get(socket)?.receive(data);
      }
    },
    close(socket) {
      featureClosed(socket);
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
  clearInterval(busyTimer);
  server.stop(true);
});
console.log(
  `iOS spike daemon on ws://127.0.0.1:${port}. No provider processes or subscription quota.`,
);
