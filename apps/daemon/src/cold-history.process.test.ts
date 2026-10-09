import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { openHistory } from "@ace/history-import";
import { coldHistoryFixture } from "../bench/cold-history-fixture.ts";

test("six thousand OpenCode sessions and owner-sized transcripts remain searchable across cold and cached scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-cold-shapes-"));
  const instances = await coldHistoryFixture(root);
  const history = await openHistory({ indexPath: join(root, "ace/index.sqlite"), instances });
  try {
    const scan = await history.scan();
    expect(scan.files).toBe(6002);
    expect(scan.unsupported).toEqual([
      { instanceId: "fixture-opencode", reason: expect.stringContaining("too large") },
    ]);
    const page = await history.list({
      type: "history.list",
      cwd: "/synthetic/workspace",
      search: "Check reconnect 5999",
    });
    expect(page.sessions.map((session) => session.title)).toEqual(["Check reconnect 5999"]);
    expect(
      (
        await history.list({
          type: "history.list",
          requestId: "list",
          cwd: "/synthetic/workspace",
          search: "Fix the reconnect",
        })
      ).sessions[0]?.title,
    ).toBe("Fix the reconnect");
    expect(
      (
        await history.list({
          type: "history.list",
          requestId: "list",
          cwd: "/synthetic/workspace",
          search: "Fix the restart",
        })
      ).sessions[0]?.title,
    ).toBe("Fix the restart");
    expect((await history.scan()).reads).toBe(0);
  } finally {
    await history.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
