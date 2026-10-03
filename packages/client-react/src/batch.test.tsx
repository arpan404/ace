import { Client } from "@ace/client";
import { FakeDaemon, ScenarioPlayer, fakeTransport, longHistory } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ClientProvider, frameBatch, useItemOrder } from "./index.ts";

const clients: Client[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function setup() {
  let now = 1;
  let ids = 0;
  const daemon = new FakeDaemon({ clock: () => (now += 1) });
  const client = new Client({
    deviceId: DeviceId.parse("batch-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
  });
  clients.push(client);
  return { daemon, client };
}

/** Animation frames that run only when the test says a frame has passed. */
function frames() {
  const queue: (() => void)[] = [];
  return {
    request: (flush: () => void) => queue.push(flush),
    next: () => act(() => queue.splice(0).forEach((flush) => flush())),
  };
}

test("many store changes inside one frame reach the screen as one render on the next frame", async () => {
  const { daemon, client } = setup();
  await client.start();
  const frame = frames();
  let renders = 0;
  function Count() {
    const order = useItemOrder("thread-router");
    renders++;
    return <output aria-label="items">{order?.length ?? 0}</output>;
  }
  render(
    <ClientProvider client={client} batch={frameBatch(frame.request)}>
      <Count />
    </ClientProvider>,
  );
  const scenario = longHistory(1);
  const script = new ScenarioPlayer(daemon, scenario);
  script.runUntilBlocked();
  await act(async () => {});
  await frame.next();
  const settled = Number(screen.getByLabelText("items").textContent);
  expect(settled).toBe(2);

  // Ten separate deliveries land between two frames: nothing renders until the frame.
  const before = renders;
  for (let n = 0; n < 10; n++)
    daemon.apply("thread-router", [
      {
        type: "item.upsert",
        agent: "root",
        item: `late-${n}`,
        draft: {
          type: "message",
          role: "user",
          complete: true,
          parts: [{ type: "text", text: `Late ${n}` }],
        },
      },
    ]);
  await act(async () => {});
  expect(renders).toBe(before);
  expect(screen.getByLabelText("items").textContent).toBe("2");
  await frame.next();
  expect(screen.getByLabelText("items").textContent).toBe("12");
  expect(renders).toBe(before + 1);
});
