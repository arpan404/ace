import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaHost } from "./supervisor-host.ts";

/*
 * A transparent relay in front of ace-media's control socket, for process tests: what a
 * squatting instance of a Windows pipe name (or anything the daemon could be pointed at) can do.
 * Each lane connection the supervisor opens goes to a relay endpoint of its own, which connects
 * to the real socket and passes every byte both ways, hello and all, recording them. `tamper`
 * may rewrite a chunk on its way (to modify or inject); it gets the lane's index (0 is the
 * first lane connected), the direction and the bytes that direction carried before it.
 */

export type Direction = "toMedia" | "toDaemon";
export type Tamper = (lane: number, direction: Direction, chunk: Buffer, before: number) => Buffer;
export type Relayed = { toMedia: Buffer[]; toDaemon: Buffer[] };

export function relayHost(host: MediaHost, tamper?: Tamper) {
  const lanes: Relayed[] = [];
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  const relay: MediaHost = {
    spawn: (binary) => host.spawn(binary),
    async connect(path) {
      const index = lanes.length;
      const traffic: Relayed = { toMedia: [], toDaemon: [] };
      lanes.push(traffic);
      const address =
        process.platform === "win32"
          ? `\\\\.\\pipe\\ace-media-relay-${process.pid}-${randomBytes(8).toString("hex")}`
          : join(mkdtempSync(join(tmpdir(), "ace-relay-")), "r.sock");
      const server = createServer((daemon) => {
        const media = createConnection(path);
        sockets.push(daemon, media);
        const carried = { toMedia: 0, toDaemon: 0 };
        const pass = (direction: Direction, from: Socket, to: Socket) => {
          from.on("data", (chunk: Buffer) => {
            const sent = tamper ? tamper(index, direction, chunk, carried[direction]) : chunk;
            carried[direction] += chunk.length;
            traffic[direction].push(Buffer.from(sent));
            to.write(sent);
          });
          from.on("close", () => to.destroy());
          from.on("error", () => {});
        };
        pass("toMedia", daemon, media);
        pass("toDaemon", media, daemon);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(address, resolve));
      return host.connect(address);
    },
  };
  return {
    host: relay,
    lanes,
    close() {
      for (const socket of sockets) socket.destroy();
      for (const server of servers) server.close();
    },
  };
}
