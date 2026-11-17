import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

/**
 * Relays of other generations, for the iOS relay socket's live tests (`RelayShortcutLiveTests`):
 * a WebSocket proxy in front of the real relay that rewrites what the phone offers, refuses an
 * upgrade, loses a held frame, or slows the link. It echoes what the relay behind it chose, so
 * the phone sees what such a relay would answer. Loopback only.
 */
export type ProxyOptions = {
  /** The subprotocols passed on to the relay: an older relay ignores what it doesn't know. */
  filter?: (offered: string[]) => string[];
  /** Turn the upgrade away before it opens, as a proxy with a header limit does. */
  refuse?: (header: string) => boolean;
  /**
   * Close with 4020 as ace cloud does after hibernating: `early` an upgrade answered with an
   * early echo, `every` all of them (a relay that would make a client dial forever).
   */
  lose?: "early" | "every";
  /** One-way delay in milliseconds on the upgrade and on every message, both ways. */
  delay?: number;
};

/** What one connection through a proxy did. Entries are cut to their prefix: no grant, no key. */
export type ProxyRecord = {
  offered: string[];
  echoed: string;
  refused: boolean;
  /** `sent` for a frame from the phone, `received` for one to it, in order, the first six. */
  order: string[];
  closed?: number;
};

const prefixes = ["ace.grant.", "ace.x1.", "ace.n1."];
const redact = (entry: string) => prefixes.find((prefix) => entry.startsWith(prefix)) ?? entry;

export const RELAY_SHORTCUTS = {
  early: "ace.early.1",
  inUpgrade: "ace.v2",
  messagePrefix: "ace.x1.",
  lostClose: 4020,
} as const;

const earlyEchoes = new Set<string>([RELAY_SHORTCUTS.early, RELAY_SHORTCUTS.inUpgrade]);

/** Without step 3: the relay never sees `ace.v2` or the message entry. */
export const stepOneOnly = (offered: string[]) =>
  offered.filter(
    (entry) =>
      entry !== RELAY_SHORTCUTS.inUpgrade && !entry.startsWith(RELAY_SHORTCUTS.messagePrefix),
  );
/** Without step 1 either: only the grant reaches the relay, which echoes it. */
export const olderRelay = (offered: string[]) =>
  stepOneOnly(offered).filter((entry) => entry !== RELAY_SHORTCUTS.early);

export async function startProxy(target: string, options: ProxyOptions = {}) {
  const records: ProxyRecord[] = [];
  const delay = options.delay ?? 0;
  const later = (run: () => void) => (delay > 0 ? setTimeout(run, delay) : run());
  const chosen = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (_protocols, request) => chosen.get(request) || false,
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(records));
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const header = String(request.headers["sec-websocket-protocol"] ?? "");
    const offered = header ? header.split(",").map((entry) => entry.trim()) : [];
    const record: ProxyRecord = {
      offered: offered.map(redact),
      echoed: "",
      refused: false,
      order: [],
    };
    records.push(record);
    const note = (what: string) => {
      if (record.order.length < 6) record.order.push(what);
    };
    if (options.refuse?.(header)) {
      record.refused = true;
      socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.on("error", () => socket.destroy());
    later(() => {
      const upstream = new WebSocket(
        new URL(request.url ?? "/", target).toString(),
        options.filter?.(offered) ?? offered,
      );
      upstream.on("error", () => socket.destroy());
      upstream.on("unexpected-response", (_request, response) => {
        later(() =>
          socket.end(`HTTP/1.1 ${response.statusCode} Refused\r\nConnection: close\r\n\r\n`),
        );
      });
      upstream.on("open", () => {
        record.echoed = redact(upstream.protocol);
        chosen.set(request, upstream.protocol);
        // From the open on: what the relay sends while the delayed answer is on its way waits.
        let client: WebSocket | undefined;
        const waiting: Buffer[] = [];
        upstream.on("message", (data: Buffer) =>
          later(() => {
            if (!client) return void waiting.push(data);
            note("received");
            if (client.readyState === WebSocket.OPEN) client.send(data);
          }),
        );
        upstream.on("close", (code) => {
          record.closed ??= code;
          later(() => client?.close(code === 1005 || code === 1006 ? 1000 : code));
        });
        later(() =>
          wss.handleUpgrade(request, socket, head, (opened) => {
            if (
              options.lose === "every" ||
              (options.lose === "early" && earlyEchoes.has(upstream.protocol))
            ) {
              record.closed = RELAY_SHORTCUTS.lostClose;
              opened.close(RELAY_SHORTCUTS.lostClose, "Early frame lost");
              upstream.close();
              return;
            }
            client = opened;
            for (const data of waiting.splice(0)) {
              note("received");
              opened.send(data);
            }
            opened.on("message", (data: Buffer) => {
              note("sent");
              later(() => upstream.readyState === WebSocket.OPEN && upstream.send(data));
            });
            opened.on("close", () => upstream.close());
            opened.on("error", () => upstream.terminate());
          }),
        );
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    log: `http://127.0.0.1:${port}/log`,
    close: async () => {
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
