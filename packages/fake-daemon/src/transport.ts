import type { Transport } from "@ace/client";
import type { Connection } from "./connection.ts";
import type { FakeDaemon } from "./daemon.ts";

/**
 * `@ace/client` transport backed by a FakeDaemon. Every hop is a microtask, so neither side
 * re-enters the other synchronously, matching socket ordering without real I/O.
 */
export function fakeTransport(daemon: FakeDaemon): Transport {
  let connection: Connection | undefined;
  let detach: (() => void) | undefined;
  return {
    open(events) {
      detach?.();
      let live = true;
      detach = () => {
        live = false;
      };
      const opened = daemon.connect({
        send: (text) =>
          queueMicrotask(() => {
            if (live) events.message(text);
          }),
        close: (code) =>
          queueMicrotask(() => {
            if (!live) return;
            live = false;
            events.close(code);
          }),
      });
      connection?.close();
      connection = opened;
      queueMicrotask(() => {
        if (live) events.open();
      });
    },
    send(text) {
      const target = connection;
      if (!target) throw new Error("Transport not open");
      queueMicrotask(() => target.receive(text));
    },
    close() {
      detach?.();
      detach = undefined;
      connection?.close();
      connection = undefined;
    },
  };
}
