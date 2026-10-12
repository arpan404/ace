import { join } from "node:path";
import { StorageCompaction } from "@ace/protocol";
import { expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

test("clean --compact compacts the daemon database instead of planning a cleanup", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const output = await invoke(home, ["clean", "--compact", "--json"]);
    expect(output.code, output.stderr).toBe(0);
    const compaction = StorageCompaction.parse(JSON.parse(output.stdout));
    expect(compaction).toMatchObject({ state: "complete", incrementalUnavailable: false });
    expect(compaction.reclaimableDatabaseBytes).toBe(0);
    const unknown = await invoke(home, ["clean", "--compact", "--abandon", "missing", "--json"]);
    // Refused: the daemon has no such compaction journal entry.
    expect(unknown.code).toBe(4);
  } finally {
    await f.daemon.close();
  }
});
