import { latest, native, until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import type { ServerMessage } from "@ace/protocol";
import { MachineProviders, type ProvidersOwner } from "./machine-info.ts";
import { PatchPump } from "./patches.ts";
import { sheetFixture } from "./sheet-fixture.ts";

const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  native.frames.length = 0;
});

/** The real client on the fake daemon, with a way to deliver a daemon broadcast by hand. */
async function connected() {
  const { client, daemon } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.state === "ready");
  const listeners = new Set<(message: ServerMessage) => void>();
  const owner: ProvidersOwner = {
    request: (request, options) => client.request(request, options),
    connectionState: () => client.connectionState(),
    onMessage(listener) {
      listeners.add(listener);
      const stop = client.onMessage(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
  };
  const broadcast = (message: ServerMessage) => {
    for (const listener of listeners) listener(message);
  };
  return { daemon, owner, broadcast };
}

test("the daemon saying its CLIs changed reads them again, and a failed read keeps the rows on screen", async () => {
  const { daemon, owner, broadcast } = await connected();
  const providers = new MachineProviders(owner, pump);
  providers.refresh();
  const first = await until(() => {
    const patch = latest("machine.providers");
    return patch && Array.isArray(patch.providers) && patch.providers.length > 0 && patch;
  });
  expect(first.problem).toBeNull();
  daemon.failRequests("providers.request");
  broadcast({ type: "providers.changed", providers: [] });
  const after = await until(() => {
    const patch = latest("machine.providers");
    return patch?.problem ? patch : undefined;
  });
  expect(after.providers).toEqual(first.providers);
  providers.dispose();
});

test("a refresh asked while a read is out reads again after it, so the newer answer shows", async () => {
  const { owner } = await connected();
  let reads = 0;
  const counting: ProvidersOwner = {
    ...owner,
    request: (request, options) => {
      if (request.type === "providers.request") reads++;
      return owner.request(request, options);
    },
  };
  const providers = new MachineProviders(counting, pump);
  providers.refresh();
  // "Check again" lands while the first read is still out: it isn't dropped.
  providers.refresh();
  await until(() => reads === 2);
  expect(reads).toBe(2);
  providers.dispose();
});
