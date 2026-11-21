import { FakeDaemon, facts } from "@ace/fake-daemon";
import { HostId, ThreadId } from "@ace/protocol";
import type { ServerWebSocket } from "bun";

/*
 * `ACE_IOS_SPIKE_PEER=<port>`: a second fixture machine in the same process, served on its own
 * loopback port, that the first one has a fleet link to, so Continue on… really carries a thread
 * there (ADR 0101) and the app's `--spike-machines <port>,<peer>` shows it arriving. An offline
 * machine is linked too, so the machine sheet shows one that can't be chosen, and one that
 * doesn't take this machine's projects, which opens Allow projects.
 */

/** Each transfer step waits this long, so its line can be seen and photographed. */
export const transferPace = Number(process.env.ACE_IOS_SPIKE_TRANSFER_MS ?? 1500);

export function servePeer(daemon: FakeDaemon, port: number, schedule: (run: () => void) => void) {
  const peer = new FakeDaemon({
    clock: Date.now,
    hostId: `ios-spike-host-${port}`,
    displayName: `studio-${port}`,
    token: "ios-spike-token",
    snapshotItems: 200,
    projectScheduler: schedule,
  });
  const away = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-spike-away",
    displayName: "Old laptop",
  });
  // A machine that takes this one's links but not its projects, for the Allow projects step.
  const desk = new FakeDaemon({ clock: Date.now, hostId: "ios-spike-desk", displayName: "Desk" });
  daemon.linkTo(peer);
  daemon.linkTo(away, { status: "offline" });
  daemon.linkTo(desk, { projects: false });
  peer.linkTo(daemon);
  // A thread whose work moved to the peer while it worked (ADR 0191): its row says so and opens
  // the thread there.
  peer.createThread({
    hasSentMessage: true,
    id: "ios-moved-there",
    workspaceId: "ace",
    title: "Speed up the snapshot cache",
    provider: "claude",
  });
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-moved",
    workspaceId: "ace",
    title: "Speed up the snapshot cache",
    provider: "claude",
  });
  daemon.apply("ios-moved", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.endTurn("root"),
    {
      type: "thread.moved",
      to: {
        hostId: HostId.parse(`ios-spike-host-${port}`),
        name: `studio-${port}`,
        threadId: ThreadId.parse("ios-moved-there"),
      },
    },
  ]);
  const connections = new Map<ServerWebSocket<undefined>, ReturnType<FakeDaemon["connect"]>>();
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port,
    fetch(request, listener) {
      if (new URL(request.url).pathname === "/health") return Response.json({ head: peer.head });
      if (listener.upgrade(request)) return;
      return new Response("Unavailable", { status: 503 });
    },
    websocket: {
      open(socket) {
        connections.set(
          socket,
          peer.connect({ send: (text) => socket.send(text), close: (code) => socket.close(code) }),
        );
      },
      message(socket, data) {
        if (typeof data === "string") connections.get(socket)?.receive(data);
      },
      close(socket) {
        connections.get(socket)?.close();
        connections.delete(socket);
      },
    },
  });
  console.log(`Linked fixture machine studio-${port} on ws://127.0.0.1:${port}.`);
  return () => server.stop(true);
}
