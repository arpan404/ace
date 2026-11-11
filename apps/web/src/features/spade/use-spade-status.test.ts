import type { ClientApi } from "@ace/client";
import type { SpadeStatus } from "@ace/protocol";
import { spadeStateLine } from "@ace/ui-core/spade-chat";
import { expect, test } from "vitest";
import type { DesktopSpade } from "./desktop-spade.ts";
import { SpadeStatusWatch } from "./use-spade-status.ts";

/** A daemon connection whose `spade.status` answers `status`; `drop` and `restore` it. */
function daemon(status: SpadeStatus) {
  let state = "ready";
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const client = {
    get state() {
      return state;
    },
    connectionState: () => ({
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    connectionGeneration: () => ({ getSnapshot: () => 1, subscribe: () => () => {} }),
    onMessage: () => () => {},
    request: async () => ({ type: "spade.status.result", requestId: "r", status }),
  };
  return {
    // Only these members of the client are used by the watch.
    client: client as unknown as ClientApi,
    drop() {
      state = "reconnecting";
      notify();
    },
  };
}

/** The desktop app's direct look at Spade's `/health`: `null` finds nobody listening. */
function app(health: { version: string | undefined } | null | undefined) {
  const desktop = { onEndpointChanged: () => () => {} } as unknown as DesktopSpade;
  return { desktop, health: async () => health };
}
const web = { desktop: undefined, health: async () => undefined };

async function watching(
  client: ClientApi,
  transport: ConstructorParameters<typeof SpadeStatusWatch>[1],
) {
  const watch = new SpadeStatusWatch(client, transport);
  const stop = watch.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { line: () => spadeStateLine(watch.get(), true), stop };
}

test("Spade stops showing as running once the daemon connection is lost", async () => {
  const connection = daemon({ state: "ready", version: "0.5.0" });
  const { line, stop } = await watching(connection.client, web);
  expect(line().ready).toBe(true);
  connection.drop();
  expect(line().ready).toBe(false);
  stop();
});

test("on the desktop, Spade not answering its own health check overrides the daemon's ready", async () => {
  const connection = daemon({ state: "ready", version: "0.5.0" });
  const { line, stop } = await watching(connection.client, app(null));
  expect(line()).toEqual({ sentence: "Spade isn't reachable.", ready: false, canTurnOn: false });
  stop();
});

test("on the desktop, Spade answering directly stays running while the daemon is away", async () => {
  const connection = daemon({ state: "ready", version: "0.5.0" });
  const { line, stop } = await watching(connection.client, app({ version: "0.5.0" }));
  connection.drop();
  expect(line().ready).toBe(true);
  stop();
});
