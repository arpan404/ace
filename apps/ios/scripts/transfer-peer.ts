import { FakeDaemon } from "@ace/fake-daemon";
import type { ServerWebSocket } from "bun";

/*
 * `ACE_IOS_SPIKE_PEER=<port>`: a second fixture machine in the same process, served on its own
 * loopback port, that the first one has a fleet link to, so Continue on… really carries a thread
 * there (ADR 0101) and the app's `--spike-machines <port>,<peer>` shows it arriving. A third,
 * offline machine is linked too, so the machine sheet shows one that can't be chosen.
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
  daemon.linkTo(peer);
  daemon.linkTo(away, { status: "offline" });
  peer.linkTo(daemon);
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
