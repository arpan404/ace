import { expect, test } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openHistory } from "./index.ts";
import { databaseFixture } from "../bench/database-fixture.ts";
import { scaleFixture } from "../bench/scale-fixture.ts";

test("six thousand OpenCode sessions and gigabyte transcripts stay pageable under the production worker limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-scale-behaviour-"));
  let service;
  try {
    const fixture = await scaleFixture(root);
    databaseFixture(root, fixture.cwd);
    service = await openHistory({
      indexPath: join(root, "ace/index.sqlite"),
      instances: fixture.instances,
    });
    const scanning = service.scan();
    const early = await service.list({ type: "history.list", cwd: fixture.cwd });
    expect(early.type).toBe("history.list");
    const scan = await scanning;
    expect(scan.files).toBe(12381);
    let page = await service.list({ type: "history.list", cwd: fixture.cwd, limit: 200 });
    let count = 0;
    for (;;) {
      count += page.sessions.length;
      if (!page.next) break;
      page = await service.list({
        type: "history.list",
        cwd: fixture.cwd,
        limit: 200,
        before: page.next,
      });
    }
    expect(count).toBe(13181);
    expect((await service.scan()).reads).toBe(0);
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});
