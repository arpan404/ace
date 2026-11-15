import { randomBytes } from "node:crypto";
import { mediaHelloBytes, mediaHelloMagic, mediaHelloVersion } from "@ace/protocol";

/*
 * ace-media's media listener as the iOS spike fixture plays it (ADR 0147 §4), with
 * `ACE_IOS_SPIKE_MEDIA=1`, so the phone's media connection runs end to end on loopback: the main
 * session's `media.connect` gets a loopback address and a single-use ticket; the connection's
 * binary hello must present it; the welcome names the connection; pings get pongs; a browser
 * subscribe naming the connection has its reply say so and its tab's video sent on the
 * connection, whose acks go on to the fake daemon so the stream keeps moving. `GET /media` reads
 * what happened; `POST /media` drops every connection (`drop`, as an ace-media restart) or
 * answers further asks as a daemon on `media.delivery: legacy` would (`legacy`, back with `media`).
 * Nothing here is ace-media's code: it is the wire contract, played for the phone.
 */

/** What the fixture needs of a phone's main socket. */
export interface PhoneMain {
  send(text: string): void;
  /** A message to the fake daemon as if the phone sent it on this socket. */
  forward(text: string): void;
}

/** What the fixture's server keeps on each socket: a media connection's, or a phone's main one. */
export type SpikeSocketData = { media?: true; main?: PhoneMain } | undefined;

/** What the fixture needs of a media socket. */
export interface MediaSocket {
  send(data: string | Uint8Array): void;
  close(code?: number): void;
}

interface Connection {
  id: string;
  ticket: Buffer;
  main: PhoneMain;
  socket: MediaSocket | undefined;
  used: boolean;
}

const encodeTicket = (bytes: Buffer) => bytes.toString("base64url");

export function spikeMedia(port: number, enabled: boolean) {
  let legacy = !enabled;
  let made = 0;
  let acks = 0;
  const connections = new Map<string, Connection>();
  const bySocket = new Map<MediaSocket, Connection>();
  /** Each phone's browser threads delivered on a connection, by the subscribe that named it. */
  const bound = new Map<PhoneMain, Map<string, string>>();
  const asked = new Map<string, { main: PhoneMain; threadId: string; connection: string }>();
  const stats = {
    issued: 0,
    welcomed: [] as string[],
    refusedHellos: 0,
    named: [] as string[],
    acks: { "browser.ack": 0, "screen.ack": 0, "devices.ack": 0 } as Record<string, number>,
    pings: 0,
    unavailable: 0,
    /** Browser acks the phone sent on its main socket: pictures delivered there. */
    mainAcks: 0,
  };

  const json = (text: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    /** A message from the phone's main socket. True when the fixture answered it itself. */
    fromPhone(main: PhoneMain, text: string): boolean {
      if (text.includes('"browser.ack"')) stats.mainAcks++;
      if (text.includes('"media.connect"')) {
        const message = json(text);
        if (message?.type !== "media.connect") return false;
        const requestId = String(message.requestId ?? "");
        if (legacy) {
          stats.unavailable++;
          const result = { ok: false, code: "unavailable", message: "media.delivery is legacy" };
          main.send(JSON.stringify({ type: "media.connect.result", requestId, result }));
          return true;
        }
        const ticket = randomBytes(32);
        const id = `mc_fixture${(++made).toString().padStart(4, "0")}`;
        connections.set(id, { id, ticket, main, socket: undefined, used: false });
        stats.issued++;
        const result = {
          ok: true,
          connection: id,
          url: `ws://127.0.0.1:${port}/media`,
          ticket: encodeTicket(ticket),
          expiresAt: Date.now() + 30_000,
        };
        main.send(JSON.stringify({ type: "media.connect.result", requestId, result }));
        return true;
      }
      if (text.includes('"browser.subscribe"')) {
        const message = json(text);
        if (message?.type !== "browser.subscribe") return false;
        const threadId = String(message.threadId);
        const media = message.media as { connection?: unknown } | undefined;
        const connection = typeof media?.connection === "string" ? media.connection : undefined;
        const live = connection ? connections.get(connection) : undefined;
        const threads = bound.get(main) ?? new Map<string, string>();
        bound.set(main, threads);
        // As ace-media would: a subscribe naming its connection is delivered there from the
        // start, before the reply; one naming none goes back to the main socket.
        if (live?.socket && live.main === main) {
          threads.set(threadId, live.id);
          asked.set(String(message.requestId), { main, threadId, connection: live.id });
        } else threads.delete(threadId);
      }
      return false;
    },
    /** A message to the phone's main socket: a bound subscribe's reply names its connection. */
    toPhone(main: PhoneMain, text: string): string {
      if (!text.includes('"browser.result"') || asked.size === 0) return text;
      const message = json(text);
      const subscribe = message ? asked.get(String(message.requestId)) : undefined;
      if (!message || !subscribe || subscribe.main !== main) return text;
      asked.delete(String(message.requestId));
      if (message.ok !== true) return text;
      stats.named.push(subscribe.connection);
      return JSON.stringify({ ...message, media: { connection: subscribe.connection } });
    },
    /** Where `threadId`'s video for this phone goes: its media connection while it is open. */
    route(main: PhoneMain, threadId: string): ((bytes: Uint8Array) => void) | undefined {
      const id = bound.get(main)?.get(threadId);
      const socket = id ? connections.get(id)?.socket : undefined;
      return socket ? (bytes) => socket.send(bytes) : undefined;
    },
    /** This phone's open media connection's socket, if any. */
    socketFor(main: PhoneMain): MediaSocket | undefined {
      let latest: MediaSocket | undefined;
      for (const connection of connections.values())
        if (connection.main === main && connection.socket) latest = connection.socket;
      return latest;
    },
    /** A media socket's message: the hello first, then acks and pings. */
    message(socket: MediaSocket, data: string | Uint8Array): void {
      const open = bySocket.get(socket);
      if (!open) {
        const hello = typeof data === "string" ? undefined : Buffer.from(data);
        const view = hello && new DataView(hello.buffer, hello.byteOffset, hello.byteLength);
        const ticket = hello?.subarray(5);
        const match =
          view &&
          ticket &&
          hello.length === mediaHelloBytes &&
          view.getUint32(0) === mediaHelloMagic &&
          hello[4] === mediaHelloVersion
            ? [...connections.values()].find((c) => !c.used && c.ticket.equals(ticket))
            : undefined;
        if (!match) {
          stats.refusedHellos++;
          return socket.close(4401);
        }
        match.used = true;
        match.socket = socket;
        bySocket.set(socket, match);
        stats.welcomed.push(match.id);
        socket.send(JSON.stringify({ type: "media.welcome", connection: match.id }));
        return;
      }
      if (typeof data !== "string") return socket.close(4400);
      const message = json(data);
      if (message?.type === "ping") {
        stats.pings++;
        return socket.send(JSON.stringify({ type: "pong" }));
      }
      const type = String(message?.type ?? "");
      if (!(type in stats.acks)) return socket.close(4400);
      stats.acks[type] = (stats.acks[type] ?? 0) + 1;
      // The fake daemon paces by acks on the main session: hand it on there.
      open.main.forward(JSON.stringify({ ...message, requestId: `media-ack-${++acks}` }));
    },
    close(socket: MediaSocket): void {
      const open = bySocket.get(socket);
      if (!open) return;
      bySocket.delete(socket);
      open.socket = undefined;
      for (const threads of bound.values())
        for (const [threadId, id] of threads) if (id === open.id) threads.delete(threadId);
    },
    /** The phone's main socket closed: its connections close with it, as with its session. */
    mainClosed(main: PhoneMain): void {
      bound.delete(main);
      for (const connection of connections.values())
        if (connection.main === main) connection.socket?.close(4410);
    },
    control(request: Request): Promise<Response> | Response | undefined {
      if (new URL(request.url).pathname !== "/media") return undefined;
      // The media connection itself: a WebSocket upgrade on the same path, never a control.
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return undefined;
      if (request.method === "GET") return Response.json({ legacy, ...stats });
      return request.json().then((body: { action?: string }) => {
        if (body.action === "legacy") legacy = true;
        if (body.action === "media") legacy = false;
        // ace-media going away (`drop`), or delivery turned to legacy: every connection ends.
        if (body.action === "drop" || body.action === "legacy")
          for (const connection of connections.values()) connection.socket?.close(1001);
        return Response.json({ ok: true });
      });
    },
  };
}
