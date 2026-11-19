import { expect, test } from "vitest";
import { spadeEndpointWatch } from "./endpoint-watch.ts";

const server = (port: number) =>
  JSON.stringify({ address: `127.0.0.1:${port}`, pid: 7, version: "0.4.0", api: 1 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An ACE_HOME as an in-memory map, with a watch on Spade's folder the test fires (with a file
 * name, or none as some systems send), counting every read.
 */
function folder() {
  const files = new Map<string, string>([
    ["/home/host-id", "host-a"],
    ["/home/spade/token", "t".repeat(43)],
    ["/home/spade/server.json", server(4100)],
  ]);
  let fire: ((file: string | undefined) => void) | undefined;
  let changes = 0;
  let reads = 0;
  const watch = spadeEndpointWatch({
    home: "/home",
    readText: async (path) => {
      reads++;
      return files.get(path);
    },
    watch: (_dir, changed) => {
      fire = changed;
      return () => (fire = undefined);
    },
    now: () => 0,
    onChange: () => changes++,
  });
  return {
    files,
    watch,
    fire: async (file: string | undefined) => {
      fire?.(file);
      await settle();
    },
    changes: () => changes,
    reads: () => reads,
  };
}

test("a restart Spade writes is seen once its server.json changes, and the app is told", async () => {
  const { files, watch, fire, changes } = folder();
  expect((await watch.current())?.port).toBe(4100);
  files.set("/home/spade/server.json", server(4200));
  // Unchanged until the folder says so: a watched reading is never re-read on every request.
  expect((await watch.current())?.port).toBe(4100);
  await fire("server.json");
  expect(changes()).toBe(1);
  expect((await watch.current())?.port).toBe(4200);
});

test("Spade's database and images changing while it streams read nothing and tell no one", async () => {
  const { watch, fire, changes, reads } = folder();
  await watch.current();
  const before = reads();
  for (const file of ["spade.sqlite", "spade.sqlite-wal", "spade.sqlite-shm", "images", "lock"])
    await fire(file);
  expect(reads()).toBe(before);
  expect(changes()).toBe(0);
});

test("a change the system doesn't name is read again, and told only if Spade moved", async () => {
  const { files, watch, fire, changes } = folder();
  await watch.current();
  await fire(undefined);
  expect(changes()).toBe(0);
  files.set("/home/spade/token", "u".repeat(43));
  await fire(undefined);
  expect(changes()).toBe(1);
  expect((await watch.current())?.token).toBe("u".repeat(43));
});

test("Spade rewriting the same files on a start that changed nothing tells no one", async () => {
  const { watch, fire, changes } = folder();
  await watch.current();
  await fire("token");
  await fire("server.json");
  expect(changes()).toBe(0);
});

test("Spade stopping takes its endpoint away", async () => {
  const { files, watch, fire, changes } = folder();
  await watch.current();
  files.delete("/home/spade/server.json");
  await fire("server.json");
  expect(changes()).toBe(1);
  expect(await watch.current()).toBeUndefined();
});

test("the endpoint names the daemon in the same home, and without its host-id there is none", async () => {
  const { files, watch, fire } = folder();
  expect((await watch.current())?.hostId).toBe("host-a");
  files.delete("/home/host-id");
  await fire(undefined);
  expect(await watch.current()).toBeUndefined();
});

test("an app whose daemon is on another machine has no local Spade", async () => {
  const watch = spadeEndpointWatch({
    home: undefined,
    readText: async () => server(4100),
    watch: () => undefined,
    now: () => 0,
    onChange: () => {},
  });
  expect(await watch.current()).toBeUndefined();
});
