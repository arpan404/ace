import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { watchEndpointFile } from "./endpoint-watch.ts";

let home: string;
beforeEach(async () => (home = await mkdtemp(join(tmpdir(), "ace-endpoint-watch-"))));
afterEach(() => rm(home, { recursive: true, force: true }));

it("wakes when the daemon writes its endpoint, whether the change came before the wait or during it", async () => {
  const watch = watchEndpointFile(home);
  if (!watch) throw new Error("A temp folder can be watched");
  try {
    await writeFile(join(home, "daemon-endpoint"), "http://127.0.0.1:4242");
    // The OS may report the change before or after this call; either way the wait ends.
    await watch.changed();
  } finally {
    watch.close();
  }
}, 15_000);

it("is undefined for a folder that does not exist, so the lookup polls instead", () => {
  expect(watchEndpointFile(join(home, "missing"))).toBeUndefined();
});
