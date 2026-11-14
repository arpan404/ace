import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { watchEndpointFile } from "./endpoint-watch.ts";

let home: string;
beforeEach(async () => (home = await mkdtemp(join(tmpdir(), "ace-endpoint-watch-"))));
afterEach(() => rm(home, { recursive: true, force: true }));

it("wakes when the daemon writes its endpoint, also when written before the wait began", async () => {
  const watch = watchEndpointFile(home);
  if (!watch) throw new Error("A temp folder can be watched");
  try {
    const first = watch.changed();
    await writeFile(join(home, "daemon-endpoint"), "http://127.0.0.1:4242");
    await first;
    await writeFile(join(home, "daemon-endpoint"), "http://127.0.0.1:4243");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The change came while nobody waited: the next wait settles at once.
    await watch.changed();
  } finally {
    watch.close();
  }
});

it("is undefined for a folder that does not exist, so the lookup polls instead", () => {
  expect(watchEndpointFile(join(home, "missing"))).toBeUndefined();
});
