import { expect, test } from "vitest";
import { spadeEndpointWatch } from "./endpoint-watch.ts";

const server = (port: number) =>
  JSON.stringify({ address: `127.0.0.1:${port}`, pid: 7, version: "0.4.0", api: 1 });

/** Spade's folder as an in-memory map, with a watch the test fires. */
function folder() {
  const files = new Map<string, string>([
    ["/home/spade/token", "t".repeat(43)],
    ["/home/spade/server.json", server(4100)],
  ]);
  let fire: (() => void) | undefined;
  let changes = 0;
  const watch = spadeEndpointWatch({
    dataDir: "/home/spade",
    readText: async (path) => files.get(path),
    watch: (_dir, changed) => {
      fire = changed;
      return () => (fire = undefined);
    },
    now: () => 0,
    onChange: () => changes++,
  });
  return { files, watch, fire: () => fire?.(), changes: () => changes };
}

test("a restart Spade writes is seen once its folder changes, and the app is told", async () => {
  const { files, watch, fire, changes } = folder();
  expect((await watch.current())?.port).toBe(4100);
  files.set("/home/spade/server.json", server(4200));
  // Unchanged until the folder says so: a watched reading is never re-read on every request.
  expect((await watch.current())?.port).toBe(4100);
  fire();
  expect(changes()).toBe(1);
  expect((await watch.current())?.port).toBe(4200);
});

test("Spade stopping takes its endpoint away", async () => {
  const { files, watch, fire } = folder();
  await watch.current();
  files.delete("/home/spade/server.json");
  fire();
  expect(await watch.current()).toBeUndefined();
});

test("an app whose daemon is on another machine has no local Spade", async () => {
  const watch = spadeEndpointWatch({
    dataDir: undefined,
    readText: async () => server(4100),
    watch: () => undefined,
    now: () => 0,
    onChange: () => {},
  });
  expect(await watch.current()).toBeUndefined();
});
